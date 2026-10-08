// Mode files as an interview copilot uses them: a resume exported to PDF by a browser, and a long
// file of prepared answers. All content here is synthetic (test/fixtures/resume.pdf was printed by
// Chromium's printToPDF from a made-up resume, so it carries the CID fonts real exported resumes do).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import WebSocket from "ws";
import { extractText } from "../src/extract.js";
import { relevantSections } from "../src/retrieve.js";

const resume = readFileSync(new URL("fixtures/resume.pdf", import.meta.url));
const pdfHelper = new URL("../bin/pdf-text", import.meta.url).pathname;

// 40 prepared answers, English and Russian headings, like a real prepared-answers file.
const companies = ["Acme", "Globex", "Initech", "Umbrella", "Hooli", "Vandelay", "Stark", "Wayne", "Tyrell", "Cyberdyne"];
const prepared = ["# Prepared answers", ...companies.flatMap((company, i) => [
  `### Why did you leave ${company}? / Почему ушли из ${company}?`,
  `Answer: At ${company} the project I was hired for shipped in month ${i + 3}; the rest was maintenance.`,
  `### What did you build at ${company}? / Что вы делали в ${company}?`,
  `Answer: The ${company} ingestion service, ${(i + 1) * 1000} events a second.`,
  `### How did you measure the result at ${company}?`,
  `Answer: A before/after p95 on the same ${company} traffic replay.`,
  `### Who else worked on it at ${company}?`,
  `Answer: Two engineers at ${company}; I owned the storage half.`,
]), "### Tell me about yourself. / Расскажите о себе.", "Answer: Backend engineer, ten companies, one line each."].join("\n\n");

test("a browser-exported resume PDF reads as its text", { skip: !existsSync(pdfHelper) && "no bin/pdf-text (macOS, built by npm run app)" }, async () => {
  const text = await extractText("resume.pdf", "application/pdf", resume);
  assert.match(text, /Acme Robotics, Platform Engineer/);
  assert.match(text, /3,412 invoices a day/);
  assert.match(text, /Русский: свободно/);
});

test("a PDF the built-in reader cannot decode is dropped, never sent as font bytes", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { extractText } from "./src/extract.js"; import { readFileSync } from "node:fs";
     process.stdout.write(await extractText("resume.pdf", "application/pdf", readFileSync("test/fixtures/resume.pdf")));`],
  { cwd: new URL("..", import.meta.url), env: { ...process.env, CUE_PDF_TEXT: "" }, encoding: "utf8" });
  assert.equal(child.stdout, "[resume.pdf: no extractable text]");
});

test("the matching prepared answer is found, in either language, and a clear hit travels alone", () => {
  const file = { name: "answers.md", text: prepared };
  const english = relevantSections([file], "Them: So why did you leave Initech?");
  assert.equal(english[0].title, "Why did you leave Initech? / Почему ушли из Initech?");
  assert.equal(english.length, 1, "nothing else scores near it");
  const russian = relevantSections([file], "Them: Расскажите немного о себе");
  assert.equal(russian[0].title, "Tell me about yourself. / Расскажите о себе.");
  for (const smallTalk of ["What is 17 x 3?", "What do you think about the weather today?", "Can you hear me okay?", "How do you deal with stress?"]) {
    assert.deepEqual(relevantSections([file], smallTalk), [], `${smallTalk}: no topic word of the file, nothing sent`);
  }
});

test("a long file with no blank lines is still searchable past its first page", () => {
  const tech = ["Kafka", "Zephyrdb", "Redis", "Postgres", "Nats"];
  const lines = Array.from({ length: 800 }, (_, i) => `Q${i}: why did you choose ${tech[i % 5]} for service ${i}? A: it fit load pattern ${i}.`);
  const file = { name: "qa.txt", text: lines.join("\n") };
  const [hit] = relevantSections([file], "Them: why Zephyrdb for service 351?");
  assert.match(hit.text, /Q351: why did you choose Zephyrdb for service 351\?/);
});

const port = 48841;
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: "Bearer mode-files-token", "content-type": "application/json" };
const rpc = async (procedure, input = {}) => (await (await fetch(`${base}/rpc/${procedure}`, { method: "POST", headers: auth, body: JSON.stringify({ json: input, meta: [] }) })).json()).json;

test("a long mode file reaches each turn as the sections that match it", { timeout: 30_000 }, async () => {
  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), CUE_LLM_BASE_URL: "mock", CUE_ASR_BASE_URL: "mock", CUE_DATA_FILE: "" },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 50)); }
    const mode = await rpc("modes/create", { name: "Interview", chatPrompt: "Answer from my files." });
    const long = prepared + "\n\n" + "Filler paragraph about nothing in particular. ".repeat(300);
    assert.ok(long.length > 12000, "longer than the whole-file budget");
    const slot = await rpc("storage/generateUploadUrl", { contentType: "text/markdown" });
    await fetch(base + slot.uploadUrl, { method: "PUT", body: long });
    await rpc("modeFiles/create", { modeId: mode.id, name: "answers.md", contentType: "text/markdown", storageKey: slot.storageKey });
    await rpc("modes/setActive", { id: mode.id });

    const { chatAgentName } = await rpc("sessions/createAmbientChatAgent", { isMobile: false });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/agents/chat-agent/${chatAgentName}?_pk=test`, { headers: { cookie: "__client_uat=1" } });
    await once(socket, "open");
    const ask = (id, text) => new Promise((resolve, reject) => {
      const parts = [];
      const timer = setTimeout(() => reject(new Error(`no answer to ${id}`)), 10_000);
      socket.on("message", function onMessage(data) {
        let envelope;
        try { envelope = JSON.parse(String(data)); } catch { return; }
        if (envelope.type !== "cf_agent_use_chat_response" || envelope.id !== id) return;
        const chunk = JSON.parse(envelope.body);
        if (chunk.type === "text-delta") parts.push(chunk.delta);
        if (envelope.done) { clearTimeout(timer); socket.off("message", onMessage); resolve(parts.join("")); }
      });
      socket.send(JSON.stringify({ id, type: "cf_agent_use_chat_request", init: { method: "POST", body: JSON.stringify({ messages: [{ id: `m-${id}`, role: "user", parts: [{ type: "text", text }] }], trigger: "submit-message" }) } }));
    });
    const hit = await ask("req00001", "<audio_transcript>\n- Them: Почему вы ушли из Hooli?\n</audio_transcript>\n\nHelp me with the conversation right now: answer what was just asked, or tell me what to say next.");
    assert.match(hit, /<mode_file_excerpts>/);
    assert.match(hit, /answers\.md: Why did you leave Hooli\?/);
    assert.match(hit, /At Hooli the project I was hired for shipped in month 7/);
    const miss = await ask("req00002", "What is 17 x 3?");
    assert.doesNotMatch(miss, /mode_file_excerpts/);
    socket.close();
  } finally {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
});

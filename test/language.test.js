// Answers follow the language of the question (Settings: Output language = Same as the question):
// a small local model otherwise answers in the language of the prepared answer it was shown.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import WebSocket from "ws";
import { languageOf, replyLanguage } from "../src/language.js";

test("the question's language: Russian or English, tech terms are not evidence", () => {
  assert.equal(languageOf("Why did you leave Langfuse?"), "English");
  assert.equal(languageOf("Почему вы ушли из Langfuse?"), "Russian");
  assert.equal(languageOf("А как у вас был setup для Kubernetes cluster autoscaling and monitoring with Prometheus?"), "Russian", "Russian made mostly of English terms");
  assert.equal(languageOf("Why did you leave Яндекс?"), "English", "an English sentence with a Russian name");
  assert.equal(languageOf("ClickHouse and Postgres?"), null, "bare tech terms tell nothing");
  assert.equal(languageOf("OK"), null);
});

test("the interviewer's latest line decides, so a switch of language is followed at once", () => {
  const en = "Can you tell me about your experience with distributed systems and how you handled consistency?";
  const ru = "Расскажите подробнее о вашем опыте с распределёнными системами и консистентностью";
  assert.equal(replyLanguage("auto", { them: [en, "А почему именно Kafka?"] }), "Russian");
  assert.equal(replyLanguage("auto", { them: [ru, "Why Kafka?"] }), "English");
  assert.equal(replyLanguage("auto", { them: ["Как вы настраивали репликацию", "в ClickHouse и Postgres?"] }), "Russian", "a last segment of bare terms leans on the one before");
  assert.equal(replyLanguage("auto", { them: ["Tell me about yourself."], typed: "дай короче" }), "English", "the interviewer decides, not the typed note");
  assert.equal(replyLanguage("auto", { typed: "Расскажи про мой опыт" }), "Russian");
  assert.equal(replyLanguage("auto", { previous: "Russian" }), "Russian", "nothing new said: keep the room's language");
  assert.equal(replyLanguage("en-US", { them: ["Расскажите о себе"] }), "English", "a fixed setting wins");
  assert.equal(replyLanguage("constructor", { them: ["Why?"] }), "English", "an unknown setting falls back to detection");
});

const port = 48851;
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: "Bearer language-token", "content-type": "application/json" };
const rpc = async (procedure, input = {}) => (await (await fetch(`${base}/rpc/${procedure}`, { method: "POST", headers: auth, body: JSON.stringify({ json: input, meta: [] }) })).json()).json;

test("each turn ends by naming the language to answer in", { timeout: 30_000 }, async () => {
  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), CUE_LLM_BASE_URL: "mock", CUE_ASR_BASE_URL: "mock", CUE_DATA_FILE: "" },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 50)); }
    assert.equal((await rpc("userConfigs/get")).displayLanguage, "auto", "new users answer in the question's language");
    const { chatAgentName } = await rpc("sessions/createAmbientChatAgent", { isMobile: false });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/agents/chat-agent/${chatAgentName}?_pk=test`, { headers: { cookie: "__client_uat=1" } });
    await once(socket, "open");
    let n = 0;
    const ask = (text) => new Promise((resolve, reject) => {
      const id = `lang${String(++n).padStart(4, "0")}`;
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
    const assist = "Help me with the conversation right now: answer what was just asked, or tell me what to say next.";
    assert.match(await ask(`<audio_transcript>\n- Them: Почему вы ушли из прошлой компании?\n</audio_transcript>\n\n${assist}`), /<reply_language>Reply in Russian:[^<]*<\/reply_language>\s*$/);
    assert.match(await ask(`<audio_transcript>\n- Me: ну смотрите\n- Them: And why did you leave your last company?\n</audio_transcript>\n\n${assist}`), /Reply in English:/);
    assert.match(await ask(assist), /Reply in English:/, "a repeated Assist with no new speech keeps the last language");
    assert.match(await ask(`<audio_transcript>\n- Them: А почему именно Kafka?\n</audio_transcript>\n\n${assist}`), /Reply in Russian:/);
    assert.match(await ask(assist), /Reply in Russian:/);
    await rpc("userConfigs/update", { displayLanguage: "en-US" });
    assert.match(await ask(`<audio_transcript>\n- Them: Расскажите о себе\n</audio_transcript>\n\n${assist}`), /Reply in English:/, "a fixed Output language wins");
    socket.close();
  } finally {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
});

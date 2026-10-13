// OpenAI transcription as Cue sends it (gpt-transcribe, the languages list), and Settings → Modes →
// Optimize: the chosen model rewrites a mode's prompt with its short files folded in, and nothing is
// saved until the page asks. Both run against stand-in servers: no key, no network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const port = 48881;
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: "Bearer speech-token", "content-type": "application/json" };
const rpc = async (procedure, input = {}) => {
  const r = await fetch(`${base}/rpc/${procedure}`, { method: "POST", headers: auth, body: JSON.stringify({ json: input, meta: [] }) });
  return { status: r.status, body: (await r.json()).json };
};

async function withServer(env, body) {
  const full = { ...process.env, PORT: String(port), CUE_LLM_BASE_URL: "mock", CUE_ASR_BASE_URL: "mock", CUE_DATA_FILE: "", CUE_LLM_PORT: "48882", ...env };
  for (const key of ["CUE_LLM_BACKEND", "CUE_ASR_BACKEND", "OPENAI_API_KEY", "CUE_TRANSCRIPTION_MODEL"]) if (!(key in env)) delete full[key];
  const server = spawn(process.execPath, ["src/server.js"], { cwd: new URL("..", import.meta.url), env: full, stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch {} if (!up) await new Promise((r) => setTimeout(r, 50)); }
    if (!up) throw new Error("server did not start");
    await body();
  } finally {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
}

// A stand-in /v1/audio/transcriptions that records each multipart request's fields.
async function fakeOpenAI() {
  const seen = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers["content-type"] } }).formData();
    const fields = {};
    for (const [name, value] of form) fields[name] = typeof value === "string" ? value : `<file ${value.size} bytes>`;
    seen.push({ path: request.url, bearer: request.headers.authorization, fields });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ text: "  hello from openai  " }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => server.close() };
}

test("OpenAI transcription sends gpt-transcribe with the language as a list, and the key", { timeout: 30_000 }, async () => {
  const fake = await fakeOpenAI();
  const wavBase64 = readFileSync(new URL("fixtures/speech-budget.wav", import.meta.url)).toString("base64");
  try {
    await withServer({ CUE_ASR_BACKEND: "openai", OPENAI_API_KEY: "sk-test-asr", CUE_ASR_BASE_URL: fake.url }, async () => {
      assert.equal((await rpc("settings/get")).body.info.transcriptionModel, "gpt-transcribe");
      const fixed = await rpc("transcription/transcribe", { wavBase64, language: "ru-RU" });
      assert.equal(fixed.status, 200);
      assert.equal(fixed.body.text, "hello from openai");
      assert.equal(fake.seen[0].path, "/v1/audio/transcriptions");
      assert.equal(fake.seen[0].bearer, "Bearer sk-test-asr");
      assert.equal(fake.seen[0].fields.model, "gpt-transcribe");
      assert.equal(fake.seen[0].fields["languages[]"], "ru", "gpt-transcribe takes a languages list");
      assert.equal(fake.seen[0].fields.language, undefined, "not the singular field");
      const auto = await rpc("transcription/transcribe", { wavBase64, language: "auto" });
      assert.equal(auto.status, 200);
      assert.equal(fake.seen[1].fields["languages[]"], undefined, "auto sends no language at all");
      assert.equal(fake.seen[1].fields.language, undefined);
    });
    await withServer({ CUE_ASR_BACKEND: "openai", OPENAI_API_KEY: "sk-test-asr", CUE_ASR_BASE_URL: fake.url, CUE_TRANSCRIPTION_MODEL: "gpt-4o-mini-transcribe" }, async () => {
      await rpc("transcription/transcribe", { wavBase64, language: "en-US" });
      assert.equal(fake.seen[2].fields.model, "gpt-4o-mini-transcribe");
      assert.equal(fake.seen[2].fields.language, "en", "the older models take one language");
      assert.equal(fake.seen[2].fields["languages[]"], undefined);
    });
  } finally {
    fake.close();
  }
});

test("Optimize rewrites a mode's prompt through the chosen model with its short files, saving nothing", { timeout: 30_000 }, async () => {
  await withServer({}, async () => {
    const mode = (await rpc("modes/create", { name: "Interview", chatPrompt: "I am the candidate. Answer briefly. Answer briefly." })).body;
    const slot = (await rpc("storage/generateUploadUrl", { contentType: "text/plain" })).body;
    await fetch(`${base}${slot.uploadUrl}`, { method: "PUT", headers: { "content-type": "text/plain" }, body: "Backend engineer at Acme Robotics since 2021; p95 latency 120 ms." });
    await rpc("modeFiles/create", { modeId: mode.id, name: "cv.txt", storageKey: slot.storageKey, contentType: "text/plain" });
    const long = "Filler paragraph about nothing in particular. ".repeat(400);
    const longSlot = (await rpc("storage/generateUploadUrl", { contentType: "text/plain" })).body;
    await fetch(`${base}${longSlot.uploadUrl}`, { method: "PUT", headers: { "content-type": "text/plain" }, body: long });
    await rpc("modeFiles/create", { modeId: mode.id, name: "notes.txt", storageKey: longSlot.storageKey, contentType: "text/plain" });

    const result = await rpc("modes/optimize", { id: mode.id });
    assert.equal(result.status, 200);
    // The mock model echoes what it was asked: the prompt and the short file went, the long one did not.
    assert.match(result.body.chatPrompt, /^\[cue local\] <instructions>/);
    assert.match(result.body.chatPrompt, /Answer briefly\. Answer briefly\./);
    assert.match(result.body.chatPrompt, /<file name="cv\.txt">\s*Backend engineer at Acme Robotics since 2021/);
    assert.doesNotMatch(result.body.chatPrompt, /notes\.txt|Filler paragraph/, "a long file rides as matched sections per turn, not here");
    assert.deepEqual(result.body.files, ["cv.txt"]);
    assert.equal(result.body.before, "I am the candidate. Answer briefly. Answer briefly.".length);
    assert.equal(result.body.after, result.body.chatPrompt.length);
    assert.equal((await rpc("modes/get", { id: mode.id })).body.chatPrompt, "I am the candidate. Answer briefly. Answer briefly.", "nothing saved until the page asks");
    assert.equal((await rpc("modes/optimize", { id: "nope" })).status, 404);
  });
});

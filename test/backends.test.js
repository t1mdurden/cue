// Answer backends beyond the local model: API keys typed into Settings, the Anthropic API path
// (driven against a stand-in Messages server, so no key or network is needed), the choice that must
// come before any model server starts, and the local-model choices Settings accepts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openRoom } from "../scripts/bench.mjs";

const port = 48871;
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: "Bearer backends-token", "content-type": "application/json" };

function boot(dataFile, env = {}) {
  const full = { ...process.env, PORT: String(port), CUE_ASR_BASE_URL: "mock", CUE_DATA_FILE: dataFile, CUE_LLM_PORT: "48872", ...env };
  for (const key of ["CUE_LLM_BACKEND", "CUE_LLM_BASE_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CUE_LLM_API_KEY", "CUE_ANTHROPIC_BASE_URL"]) if (!(key in env)) delete full[key];
  return spawn(process.execPath, ["src/server.js"], { cwd: new URL("..", import.meta.url), env: full, stdio: ["ignore", "pipe", "pipe"] });
}
async function call(procedure, input = {}) {
  const r = await fetch(`${base}/rpc/${procedure}`, { method: "POST", headers: auth, body: JSON.stringify({ json: input, meta: [] }) });
  return { status: r.status, body: (await r.json()).json };
}
async function waitForHealth() {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health`)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("server did not start");
}
async function stop(server) {
  server.kill("SIGTERM");
  await once(server, "exit");
}

// A stand-in for the Messages API: streams "Hello from claude" as Anthropic's SSE events, rejects
// any key but the expected one with Anthropic's 401 body, and records what it was sent.
async function fakeAnthropic(expectedKey) {
  const seen = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push({ path: request.url, key: request.headers["x-api-key"], body: JSON.parse(body || "{}") });
    if (request.headers["x-api-key"] !== expectedKey) {
      response.writeHead(401, { "content-type": "application/json", "request-id": "req_test" });
      return response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-fable-5-1", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    for (const text of ["Hello ", "from ", "claude"]) event("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
    event("message_stop", {});
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

test("an API key typed into Settings is sealed on disk, never echoed, kept across a restart, and forgettable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cue-keys-"));
  const dataFile = join(dir, "store.json");
  const key = "test-anthropic-key-SECRET-0f9e8d7c";
  let server = boot(dataFile);
  try {
    await waitForHealth();
    const saved = await call("settings/update", { llmBackend: "anthropic", apiKeys: { anthropic: key } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.keys.anthropic, { set: true, source: "saved", hint: `…${key.slice(-4)}` });
    assert.ok(!JSON.stringify(saved.body).includes("SECRET"), "the reply carries no key");
    await stop(server);
    const disk = readFileSync(dataFile, "utf8");
    assert.ok(!disk.includes("SECRET"), "no plain key in the store");
    assert.match(JSON.parse(disk).settings.apiKeys.anthropic, /^cue1\./, "the key is sealed");

    server = boot(dataFile);
    await waitForHealth();
    assert.equal((await call("settings/get")).body.keys.anthropic.set, true, "the key survives a restart");
    const bad = await call("settings/update", { apiKeys: { anthropic: "two words" } });
    assert.equal(bad.status, 422, "a key with whitespace inside is refused");
    await call("settings/update", { apiKeys: { anthropic: null } });
    assert.equal((await call("settings/get")).body.keys.anthropic.set, false);
    assert.deepEqual(await call("settings/test").then((r) => r.body), { ok: false, error: "No Anthropic API key. Add one in Settings → Model." });
  } finally { await stop(server).catch(() => {}); }
});

test("the Anthropic backend streams through the Messages API with the screenshot as an image block, and names a rejected key", async () => {
  const fake = await fakeAnthropic("sk-ant-good");
  const dataFile = join(mkdtempSync(join(tmpdir(), "cue-anthropic-")), "store.json");
  const server = boot(dataFile, { CUE_LLM_BACKEND: "anthropic", ANTHROPIC_API_KEY: "sk-ant-good", CUE_ANTHROPIC_BASE_URL: fake.url });
  try {
    await waitForHealth();
    const ok = (await call("settings/test")).body;
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.text, "Hello from claude");
    const sent = fake.seen.at(-1);
    assert.equal(sent.path, "/v1/messages");
    assert.equal(sent.body.model, "claude-fable-5-1");
    assert.equal(sent.body.stream, true);
    assert.deepEqual(sent.body.output_config, { effort: "low" });
    assert.equal(sent.body.fallbacks, undefined, "no Anthropic-only fields go to another server");

    // The overlay's turn with a screenshot (the protocol the overlay speaks, scripts/bench.mjs): the
    // image reaches the API as a base64 block before the text.
    const room = await openRoom(base);
    const messageId = randomUUID();
    const png = readFileSync(new URL("./fixtures/screen-probe.png", import.meta.url)).toString("base64");
    await room.call("uploadScreenshot", { messageId, dataBase64: png, contentType: "image/png" });
    const answer = await room.ask([{ id: messageId, role: "user", parts: [{ type: "text", text: "What is on my screen?" }] }]);
    room.socket.close();
    assert.equal(answer.error, null);
    assert.equal(answer.text, "Hello from claude");
    const turn = fake.seen.at(-1).body.messages.at(-1);
    assert.equal(turn.content[0].type, "image");
    assert.equal(turn.content[0].source.type, "base64");
    assert.equal(turn.content.at(-1).type, "text");

    await call("settings/update", { apiKeys: { anthropic: "sk-ant-wrong" } });
    const started = Date.now();
    const rejected = (await call("settings/test")).body;
    assert.deepEqual(rejected, { ok: false, error: "Anthropic rejected the API key. Check it in Settings → Model." });
    assert.ok(Date.now() - started < 5000, "a rejected key fails fast, not after retries");
  } finally {
    await stop(server);
    fake.close();
  }
});

test("until a backend is chosen nothing starts or downloads; choosing This Mac asks for the model instead of fetching it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cue-chosen-"));
  const server = boot(join(dir, "store.json"), { HF_HUB_CACHE: join(dir, "hf"), CUE_MODELS_DIR: join(dir, "models"), CUE_ASR_BACKEND: "openai" });
  try {
    await waitForHealth();
    const first = (await call("settings/get")).body;
    assert.equal(first.chosen, false, "local is only the suggestion");
    assert.equal(first.setupDone, false, "a fresh store goes through Setup");
    assert.equal((await call("models/status")).body.servers.llama.state, "off");
    await call("settings/update", { llmBackend: "local" });
    let status;
    for (let i = 0; i < 40 && (status = (await call("models/status")).body).servers.llama.state === "off"; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(status.servers.llama.state, "needs-model");
    assert.equal(status.download.state, "idle", "the download waits for the person");
    assert.equal((await call("settings/get")).body.chosen, true);
  } finally { await stop(server); }
});

test("the openai backend still goes where CUE_LLM_BASE_URL and CUE_CHAT_MODEL point, never silently to OpenAI", async () => {
  const proc = spawn(process.execPath, ["-e", `
    Object.assign(process.env, { CUE_LLM_BACKEND: "openai", CUE_LLM_BASE_URL: "http://10.0.0.5:8000/v1", CUE_CHAT_MODEL: "my-model" });
    const { config } = await import("./src/config.js");
    console.log(config.llmBaseUrl, config.chatModel);
  `], { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  proc.stdout.on("data", (chunk) => { out += chunk; });
  await once(proc, "exit");
  assert.equal(out.trim(), "http://10.0.0.5:8000/v1 my-model");
});

test("Settings takes a catalogue model, a Hugging Face GGUF or a file on disk, and refuses anything else", async () => {
  const dataFile = join(mkdtempSync(join(tmpdir(), "cue-localmodel-")), "store.json");
  const server = boot(dataFile, { CUE_LLM_BASE_URL: "mock" });
  try {
    await waitForHealth();
    const catalogue = (await call("models/catalogue")).body;
    assert.deepEqual(catalogue.entries.map((e) => e.id), ["qwen3-vl-4b", "qwen3-vl-2b", "qwen3-vl-8b"]);
    assert.ok(["qwen3-vl-4b", "qwen3-vl-2b"].includes(catalogue.recommended));
    assert.equal((await call("settings/update", { localModel: "qwen3-vl-2b" })).status, 200);
    const hub = { repo: "ggml-org/SmolVLM-256M-Instruct-GGUF", file: "SmolVLM-256M-Instruct-Q8_0.gguf", mmproj: "mmproj-SmolVLM-256M-Instruct-Q8_0.gguf" };
    assert.deepEqual((await call("settings/update", { localModel: hub })).body.localModel, hub);
    for (const bad of [
      "gpt-4",
      { repo: "a/b", file: "../../etc/passwd.gguf" },
      { repo: "not a repo", file: "x.gguf" },
      { repo: "a/b", file: "weights.bin" },
      { path: "relative/model.gguf" },
      { path: "/nonexistent/model.gguf" },
    ]) {
      assert.equal((await call("settings/update", { localModel: bad })).status, 422, JSON.stringify(bad));
    }
    assert.deepEqual((await call("settings/get")).body.localModel, hub, "a refused choice changes nothing");
  } finally { await stop(server); }
});

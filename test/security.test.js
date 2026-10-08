import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import WebSocket from "ws";

const port = 48821;
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: "Bearer security-token", "content-type": "application/json" };

function boot(dataFile) {
  return spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), CUE_LLM_BASE_URL: "mock", CUE_ASR_BASE_URL: "mock", CUE_DATA_FILE: dataFile },
    stdio: ["ignore", "ignore", "ignore"],
  });
}
async function rpc(procedure, input = {}) {
  const r = await fetch(`${base}/rpc/${procedure}`, { method: "POST", headers: auth, body: JSON.stringify({ json: input, meta: [] }) });
  return { status: r.status, body: (await r.json()).json };
}

// Kill a child and wait only if it is still alive: awaiting "exit" on an already-exited child
// never resolves (the event already fired).
async function stopChild(child) {
  if (child.exitCode === null && !child.killed) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function waitForHealth() {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/health`)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("server did not start");
}

test("transcripts are sealed at rest and readable after a restart", async () => {
  const dataFile = join(mkdtempSync(join(tmpdir(), "cue-sec-")), "store.json");
  let child = boot(dataFile);
  try {
    await waitForHealth();
    const session = (await rpc("sessions/create", {})).body;
    const transcript = [{ role: "them", text: "the launch code is swordfish", status: "ready", createdAt: new Date().toISOString() }];
    await rpc("sessions/end", { id: session.id, transcript });
    await new Promise((r) => setTimeout(r, 400)); // let the debounced save flush
    child.kill("SIGKILL"); await once(child, "exit");
    const raw = readFileSync(dataFile, "utf8");
    assert.ok(!raw.includes("swordfish"), "no transcript plaintext in data/store.json");
    assert.ok(raw.includes("$cue"), "conversation content is sealed");
    child = boot(dataFile);
    await waitForHealth();
    const got = (await rpc("sessions/get", { id: session.id })).body;
    assert.equal(got.transcript[0].text, "the launch code is swordfish");
  } finally { await stopChild(child); }
});

test("server rejects malformed input instead of storing it", async () => {
  const child = boot(join(mkdtempSync(join(tmpdir(), "cue-sec-")), "store.json"));
  try {
    await waitForHealth();
    assert.equal((await rpc("sessions/create", { meetingId: 123 })).status, 422);
    assert.equal((await rpc("sessions/end", { id: "x", transcript: [{ role: "attacker", text: "hi" }] })).status, 422);
    assert.equal((await rpc("tags/create", { name: 123 })).status, 422);
    const upload = await fetch(`${base}/uploads/../../etc/passwd?content_type=text/plain`, { method: "PUT", body: "x" });
    assert.ok([404, 422].includes(upload.status), `unexpected upload status ${upload.status}`);
  } finally { await stopChild(child); }
});

test("an OpenAI key alone never routes speech off the machine", async () => {
  // config is env-bound at import; assert the resolved default in a fresh process.
  const proc = spawn(process.execPath, ["-e", `
    process.env.OPENAI_API_KEY = "sk-test";
    delete process.env.CUE_ASR_BASE_URL; delete process.env.CUE_ASR_BACKEND; delete process.env.CUE_LLM_BACKEND;
    const { config } = await import("./src/config.js");
    console.log(config.asrBaseUrl, config.asrApiKey, config.llmBackend);
  `], { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  proc.stdout.on("data", (c) => (out += c));
  await once(proc, "exit");
  const [asrBaseUrl, asrApiKey, llmBackend] = out.trim().split(" ");
  assert.equal(asrBaseUrl, "http://127.0.0.1:8082/v1", "ASR stays local without an explicit choice");
  assert.equal(asrApiKey, "", "no bearer key is sent to the local whisper server");
  assert.equal(llmBackend, "local", "chat stays local without an explicit choice");
});

test("room message displayText and content are sealed at rest too", async () => {
  const dataFile = join(mkdtempSync(join(tmpdir(), "cue-sec-")), "store.json");
  let child = boot(dataFile);
  try {
    await waitForHealth();
    const { chatAgentName } = (await rpc("sessions/createAmbientChatAgent", { isMobile: false })).body;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/agents/chat-agent/${chatAgentName}?_pk=test`, { headers: { cookie: "__client_uat=1" } });
    await new Promise((r, j) => { socket.once("open", r); socket.once("error", j); });
    socket.send(JSON.stringify({ type: "cf_agent_chat_messages", messages: [
      { id: randomUUID(), role: "user", parts: [{ type: "text", text: "hidden question" }], displayText: "what did they mean by dolphin", content: "content copy of dolphin" },
    ] }));
    await new Promise((r) => setTimeout(r, 500)); // debounced save
    socket.terminate(); // hard-close: a killed server cannot complete a close handshake
    child.kill("SIGKILL"); await once(child, "exit");
    const raw = readFileSync(dataFile, "utf8");
    assert.ok(!raw.includes("dolphin"), "no displayText/content plaintext in data/store.json");
    assert.ok(!raw.includes("hidden question"), "no parts text plaintext either");
  } finally { await stopChild(child); }
});

test("uploads accept only slots the server minted", async () => {
  const child = boot(join(mkdtempSync(join(tmpdir(), "cue-sec-")), "store.json"));
  try {
    await waitForHealth();
    const invented = await fetch(`${base}/uploads/modes/${randomUUID()}?content_type=text/plain`, { method: "PUT", body: "x" });
    assert.equal(invented.status, 404, "self-invented UUID is not an upload slot");
    const minted = (await rpc("storage/generateUploadUrl", { contentType: "text/plain" })).body;
    const real = await fetch(base + minted.uploadUrl, { method: "PUT", body: "x" });
    assert.equal(real.status, 200, "a minted slot uploads");
  } finally { await stopChild(child); }
});

test("a rejected settings patch changes nothing", async () => {
  const child = boot(join(mkdtempSync(join(tmpdir(), "cue-sec-")), "store.json"));
  try {
    await waitForHealth();
    const before = (await rpc("settings/get")).body.llmBackend;
    const bad = await rpc("settings/update", { llmBackend: "claude", contentProtection: "yes" });
    assert.equal(bad.status, 422);
    const after = (await rpc("settings/get")).body.llmBackend;
    assert.equal(after, before, "half a patch must not survive its own rejection");
  } finally { await stopChild(child); }
});

test("a null RPC body is a 422, not a crash", async () => {
  const child = boot(join(mkdtempSync(join(tmpdir(), "cue-sec-")), "store.json"));
  try {
    await waitForHealth();
    const r = await fetch(`${base}/rpc/sessions/create`, { method: "POST", headers: auth, body: '{"json":null,"meta":[]}' });
    assert.equal(r.status, 422);
  } finally { await stopChild(child); }
});

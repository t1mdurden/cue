import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";

const port = 48799;
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: "Bearer pipeline-token", "content-type": "application/json" };

function boot(dataFile) {
  return spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), CUE_LLM_BASE_URL: "mock", CUE_ASR_BASE_URL: "mock", CUE_DATA_FILE: dataFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function rpc(procedure, input) {
  const response = await fetch(`${base}/rpc/${procedure}`, { method: "POST", headers: auth, body: JSON.stringify({ json: input, meta: [] }) });
  const body = await response.json();
  assert.equal(response.status, 200, `${procedure} -> ${response.status}`);
  return body.json;
}

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not start");
}

function openRoom(room) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/agents/chat-agent/${room}?_pk=test`, { headers: { cookie: "__client_uat=1" } });
  return once(socket, "open").then(() => socket);
}

// One chat turn over the socket; returns the concatenated assistant text.
function chat(socket, messages) {
  const requestId = "req12345";
  const parts = [];
  return new Promise((resolve) => {
    const onMessage = (data) => {
      const envelope = JSON.parse(String(data));
      if (envelope.type !== "cf_agent_use_chat_response" || envelope.id !== requestId) return;
      const chunk = JSON.parse(envelope.body);
      if (chunk.type === "text-delta") parts.push(chunk.delta);
      if (envelope.done) { socket.off("message", onMessage); resolve(parts.join("")); }
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ id: requestId, type: "cf_agent_use_chat_request", init: { method: "POST", body: JSON.stringify({ messages, trigger: "submit-message" }) } }));
  });
}

test("a screenshot reaches its own turn and is not re-sent on the next turn", async () => {
  const child = boot("");
  try {
    await waitForHealth();
    const { chatAgentName } = await rpc("sessions/createAmbientChatAgent", { isMobile: false });
    const socket = await openRoom(chatAgentName);

    // Turn 1 carries a screenshot keyed by its messageId; the mock echoes [images:1].
    const m1 = "msg-one";
    await socketRpc(socket, "uploadScreenshot", { messageId: m1, dataBase64: Buffer.from("fake").toString("base64"), contentType: "image/png" });
    const answer1 = await chat(socket, [{ id: m1, role: "user", parts: [{ type: "text", text: "first" }] }]);
    assert.match(answer1, /\[images:1\]/, "turn 1 must receive its screenshot");

    // Turn 2 has no new screenshot; the consumed one must not reappear.
    const answer2 = await chat(socket, [
      { id: m1, role: "user", parts: [{ type: "text", text: "first" }] },
      { id: "msg-two", role: "user", parts: [{ type: "text", text: "second" }] },
    ]);
    socket.close();
    assert.ok(!/\[images:/.test(answer2), "turn 2 must carry no image");
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});

// macOS only: bin/screen-text is built from native/screen-text.swift by `npm run app`.
const screenText = new URL("../bin/screen-text", import.meta.url).pathname;
test("the local model's turn carries the screenshot's text, read on this Mac", { skip: !existsSync(screenText) && "no bin/screen-text (macOS, built by npm run app)" }, async () => {
  const child = boot("");
  try {
    await waitForHealth();
    const { chatAgentName } = await rpc("sessions/createAmbientChatAgent", { isMobile: false });
    const socket = await openRoom(chatAgentName);
    // A synthetic IDE screen (scripts/make-fixtures.py) whose 15 px amounts a 512-token image blurs.
    const png = readFileSync(new URL("fixtures/screen-dense.png", import.meta.url));
    await socketRpc(socket, "uploadScreenshot", { messageId: "msg-ocr", dataBase64: png.toString("base64"), contentType: "image/png" });
    const answer = await chat(socket, [{ id: "msg-ocr", role: "user", parts: [{ type: "text", text: "what is the storage line item?" }] }]);
    socket.close();
    assert.match(answer, /\[images:1\]/, "the picture still goes too");
    assert.match(answer, /<screen_text>/);
    assert.match(answer, /storage 201\.90/, "the amount arrives exactly, next to its label");
    assert.match(answer, /Decimal\('0\.0'\)/);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});

test("store survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cue-pipeline-"));
  const dataFile = join(dir, "store.json");
  let child = boot(dataFile);
  try {
    await waitForHealth();
    const mode = await rpc("modes/create", { name: "Persisted", chatPrompt: "x" });
    await rpc("modes/setActive", { id: mode.id });
    child.kill("SIGTERM");
    await once(child, "exit");

    child = boot(dataFile);
    await waitForHealth();
    const { items } = await rpc("modes/list", {});
    assert.equal(items.length, 1);
    assert.equal(items[0].name, "Persisted");
    assert.equal(items[0].isActive, true);
    const snapshot = JSON.parse(readFileSync(dataFile, "utf8"));
    assert.equal(snapshot.users.length, 1);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});

// helpers that reach into the server over a debug-free path: the agent RPC side channel, and a
// room-state probe exposed only in tests via a count the agent already tracks.
function socketRpc(socket, method, input) {
  const id = `rpc-${method}`;
  return new Promise((resolve) => {
    const onMessage = (data) => {
      const message = JSON.parse(String(data));
      if (message.type === "rpc" && message.id === id) { socket.off("message", onMessage); resolve(message.result); }
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ id, type: "rpc", method, args: [input] }));
  });
}

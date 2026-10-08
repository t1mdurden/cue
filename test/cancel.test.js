import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import WebSocket from "ws";

const port = 48861;
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: "Bearer cancel-token", "content-type": "application/json" };

// A stand-in for `claude -p --input-format stream-json`: each question gets a slow answer (first
// word after 300 ms, then 40 words 50 ms apart, 2.3 s in all), and an interrupt control request
// ends the turn at once, the way the real CLI does. Every question and interrupt is logged.
function fakeClaude() {
  const dir = mkdtempSync(join(tmpdir(), "cue-fake-claude-"));
  writeFileSync(join(dir, "claude"), `#!/usr/bin/env node
const fs = require("fs");
const log = (line) => fs.appendFileSync(${JSON.stringify(join(dir, "calls"))}, line + "\\n");
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let timer = null;
const finish = () => { clearInterval(timer); timer = null; out({ type: "result", subtype: "success", is_error: false, result: "" }); };
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "user") {
    log("ask");
    let tick = 0;
    timer = setInterval(() => {
      if (++tick <= 6) return;
      out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "word " } } });
      if (tick >= 46) finish();
    }, 50);
  }
  if (message.type === "control_request" && message.request?.subtype === "interrupt") {
    log("interrupt");
    out({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
    if (timer) finish();
  }
});
`);
  chmodSync(join(dir, "claude"), 0o755);
  return dir;
}

test("a question replaced while it waits stops the model, so the new one is not stuck behind it", { timeout: 30_000 }, async () => {
  const bin = fakeClaude();
  const dataFile = join(mkdtempSync(join(tmpdir(), "cue-cancel-")), "store.json");
  const env = { ...process.env, PORT: String(port), CUE_LLM_BASE_URL: "mock", CUE_ASR_BASE_URL: "mock", CUE_DATA_FILE: dataFile,
    CUE_LLM_BACKEND: "claude", PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
  const server = spawn(process.execPath, ["src/server.js"], { cwd: new URL("..", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"] });
  let socket;
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 50)); }
    const response = await fetch(`${base}/rpc/sessions/createAmbientChatAgent`, { method: "POST", headers: auth, body: JSON.stringify({ json: { isMobile: false }, meta: [] }) });
    const room = (await response.json()).json.chatAgentName;
    socket = new WebSocket(`ws://127.0.0.1:${port}/agents/chat-agent/${room}?_pk=${randomUUID()}`, { headers: { cookie: "__client_uat=1" } });
    await once(socket, "open");

    // What the overlay sends: the question, then on a second Assist a cancel and the new question
    // with the replaced turn left empty in the history.
    const ask = (id, messages) => {
      const sent = Date.now();
      const answer = new Promise((resolve) => {
        let first = null, text = "";
        socket.on("message", function listen(data) {
          const envelope = JSON.parse(String(data));
          if (envelope.type !== "cf_agent_use_chat_response" || envelope.id !== id) return;
          const chunk = JSON.parse(envelope.body);
          if (chunk.type === "text-delta") { first ??= Date.now() - sent; text += chunk.delta; }
          if (envelope.done) { socket.off("message", listen); resolve({ first, text }); }
        });
      });
      socket.send(JSON.stringify({ id, type: "cf_agent_use_chat_request", init: { method: "POST", body: JSON.stringify({ messages, trigger: "submit-message" }) } }));
      return answer;
    };
    const user = (text) => ({ id: randomUUID(), role: "user", parts: [{ type: "text", text }] });
    // An earlier answer, as in the live room: the process is warm when the question comes.
    const warm = user("Tell me about yourself.");
    const earlier = [warm, { id: randomUUID(), role: "assistant", parts: [{ type: "text", text: (await ask("warm", [warm])).text }] }];
    const first = user("How do you design agent memory?");
    const replaced = ask("first", [...earlier, first]);
    await new Promise((r) => setTimeout(r, 100)); // still waiting for its first word
    socket.send(JSON.stringify({ type: "cf_agent_chat_request_cancel", id: "first" }));
    const second = await ask("second", [...earlier, first, { id: randomUUID(), role: "assistant", parts: [{ type: "text", text: "" }] }, user("How do you design agent memory? So it stays useful?")]);
    await replaced;

    assert.match(second.text, /word/);
    // The fake's whole answer takes 2.3 s; waiting for it puts the first word near 2.5 s.
    assert.ok(second.first < 1200, `the new question's first word came ${second.first} ms after it was asked`);
    assert.deepEqual(readFileSync(join(bin, "calls"), "utf8").trim().split("\n"), ["ask", "ask", "interrupt", "ask"]);
  } finally {
    socket?.close();
    server.kill("SIGTERM");
    await once(server, "exit");
  }
});

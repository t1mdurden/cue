#!/usr/bin/env node
// Drive the agent exactly as the overlay does: open a room, upload attachments, stream one answer.
//   node scripts/ask.mjs --text "what code is on screen?" --image shot.png
//   node scripts/ask.mjs --room <name> --text "follow-up"      (reuses a room's history)
// Prints the answer, then a JSON line with timings so checks can parse it.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, i, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[i + 1]]] : pairs), []),
);
const server = args.server || "http://127.0.0.1:8787";
const headers = { authorization: `Bearer ${args.token || "dev-token"}`, "content-type": "application/json" };

async function rpc(procedure, input = {}) {
  const response = await fetch(`${server}/rpc/${procedure}`, { method: "POST", headers, body: JSON.stringify({ json: input, meta: [] }) });
  const body = await response.json();
  if (!response.ok) throw new Error(`${procedure}: ${body?.json?.message}`);
  return body.json;
}

const room = args.room || (await rpc("sessions/createAmbientChatAgent", { isMobile: false })).chatAgentName;
const history = args.room ? await (await fetch(`${server}/agents/chat-agent/${room}/get-messages`)).json() : [];
const socket = new WebSocket(`${server.replace(/^http/, "ws")}/agents/chat-agent/${room}?_pk=${randomUUID()}`, {
  headers: { cookie: "__client_uat=1" },
});
await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });

const call = (method, input) => new Promise((resolve, reject) => {
  const id = randomUUID();
  const onMessage = (data) => {
    const message = JSON.parse(String(data));
    if (message.type !== "rpc" || message.id !== id) return;
    socket.off("message", onMessage);
    message.success ? resolve(message.result) : reject(new Error(message.error));
  };
  socket.on("message", onMessage);
  socket.send(JSON.stringify({ id, type: "rpc", method, args: [input] }));
});

const messageId = randomUUID();
if (args.image) {
  await call("uploadScreenshot", { messageId, dataBase64: readFileSync(args.image).toString("base64"), contentType: "image/png" });
}
const message = { id: messageId, role: "user", parts: [{ type: "text", text: args.text || "Assist" }] };
const requestId = randomUUID().slice(0, 8);
const started = Date.now();
let firstToken = null;
let answer = "";
let error = null;
await new Promise((resolve) => {
  socket.on("message", (data) => {
    const envelope = JSON.parse(String(data));
    if (envelope.type !== "cf_agent_use_chat_response" || envelope.id !== requestId) return;
    const chunk = JSON.parse(envelope.body);
    if (chunk.type === "text-delta") {
      firstToken ??= Date.now() - started;
      answer += chunk.delta;
      process.stdout.write(chunk.delta);
    }
    if (chunk.type === "error") error = chunk.errorText;
    if (envelope.done) resolve();
  });
  socket.send(JSON.stringify({
    id: requestId,
    type: "cf_agent_use_chat_request",
    init: { method: "POST", body: JSON.stringify({ messages: [...history, message], trigger: "submit-message" }) },
  }));
});
socket.close();
process.stdout.write("\n");
console.log(JSON.stringify({ room, ttftMs: firstToken, totalMs: Date.now() - started, chars: answer.length, error }));

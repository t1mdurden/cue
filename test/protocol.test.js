import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import WebSocket from "ws";

const port = 48787;
const base = `http://127.0.0.1:${port}`;

test("oRPC, active mode, and agent stream protocol", async () => {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      CUE_LLM_BASE_URL: "mock",
      CUE_ASR_BASE_URL: "mock",
      CUE_DATA_FILE: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForHealth();
    const auth = { authorization: "Bearer test-token", "content-type": "application/json" };

    const mode = await rpc("modes/create", {
      name: "Marker mode",
      chatPrompt: "When the user says MODEMARK, reply with CUE-TEST-MODE and nothing else.",
    });
    await rpc("modes/setActive", { id: mode.id });
    const ambient = await rpc("sessions/createAmbientChatAgent", { isMobile: false });
    assert.equal(ambient.chatAgentName.length, 36);

    const messages = await openAgent(ambient.chatAgentName);
    assert.equal(messages.at(-1).type, "cf_agent_mcp_servers");

    const socket = messages.socket;
    const requestId = "test1234";
    const received = [];
    socket.on("message", (data) => {
      const envelope = JSON.parse(String(data));
      if (envelope.type === "cf_agent_use_chat_response" && envelope.id === requestId) received.push(envelope);
      if (envelope.done) socket.close();
    });
    socket.send(JSON.stringify({
      id: requestId,
      type: "cf_agent_use_chat_request",
      init: {
        method: "POST",
        body: JSON.stringify({
          messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "MODEMARK" }] }],
          trigger: "submit-message",
        }),
      },
    }));
    await once(socket, "close");

    const stream = received.map((item) => JSON.parse(item.body));
    assert.equal(stream.at(0).type, "start");
    assert.equal(stream.at(1).type, "start-step");
    assert.equal(stream.at(2).type, "text-start");
    assert.ok(stream.at(2).providerMetadata.openai.itemId.startsWith("msg_"));
    const answer = stream.filter((item) => item.type === "text-delta").map((item) => item.delta).join("");
    assert.equal(answer, "CUE-TEST-MODE");
    assert.equal(stream.at(-1).messageMetadata.finishReason, "stop");
    assert.equal(received.at(-1).done, true);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});

async function rpc(procedure, input) {
  const response = await fetch(`${base}/rpc/${procedure}`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ json: input, meta: [] }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  return body.json;
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Server did not start");
}

async function openAgent(room) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/agents/chat-agent/${room}?_pk=test`, {
    headers: { cookie: "__client_uat=1234567890" },
  });
  const messages = [];
  messages.socket = socket;
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    messages.push(message);
    if (messages.length === 3) {
      // Keep listening after handshake; the caller installs its request listener first.
      socket.emit("handshake-complete");
    }
  });
  await once(socket, "handshake-complete");
  return messages;
}

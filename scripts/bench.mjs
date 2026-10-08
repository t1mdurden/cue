#!/usr/bin/env node
// Time-to-first-token for a context-aware answer, driven against the real app server exactly as the
// overlay drives it: a live session room, a screenshot upload, and a hidden message carrying the
// transcript. Every run's screenshot gets unique pixels so a model-side image cache cannot hit, which
// is what a real screen looks like. Fails if an answer ignores the screen or the transcript.
//   npm run bench                      5 runs against http://127.0.0.1:8787
//   npm run bench -- --runs 10 --image test/fixtures/screen-dense.png --server http://127.0.0.1:8787 --settle 4000
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import WebSocket from "ws";

// Shared with scripts/eval-context.mjs: the same room, screenshot and transcript path the
// overlay drives, so a latency number and an answer-quality number describe one pipeline.
export const transcript = [
  ["them", "Thanks for joining. Quick agenda: the cloud bill, then hiring."],
  ["me", "Sounds good."],
  ["them", "Finance flagged the latest invoice, can you pull it up?"],
  ["me", "Yes, I have it on screen."],
  ["them", "Also, the vendor review moved to Thursday."],
  ["me", "Okay, Thursday works."],
  ["them", "Marketing wants two more weeks for the launch."],
  ["me", "That is fine by me."],
  ["them", "So what is the total on that invoice, and when is the review again?"],
  ["me", "One second."],
];

export function contextMessage(instruction) {
  return [
    "<screen_use>\nCurrent preference: required\n</screen_use>",
    `<audio_transcript>\n${transcript.map(([role, text]) => `- ${role === "me" ? "Me" : "Them"}: ${text}`).join("\n")}\n</audio_transcript>`,
    instruction,
  ].join("\n\n");
}

const rpc = async (server, procedure, input = {}) => {
  const headers = { authorization: "Bearer bench", "content-type": "application/json" };
  const response = await fetch(`${server}/rpc/${procedure}`, { method: "POST", headers, body: JSON.stringify({ json: input, meta: [] }) });
  const body = await response.json();
  if (!response.ok) throw new Error(`${procedure}: ${body?.json?.message}`);
  return body.json;
};

export async function openRoom(server) {
  const { chatAgentName } = await rpc(server, "sessions/create", {});
  const socket = new WebSocket(`${server.replace(/^http/, "ws")}/agents/chat-agent/${chatAgentName}?_pk=${randomUUID()}`, { headers: { cookie: "__client_uat=1" } });
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
  const ask = (messages) => new Promise((resolve) => {
    const requestId = randomUUID().slice(0, 8);
    const started = Date.now();
    let ttft = null, text = "", error = null;
    const onMessage = (data) => {
      const envelope = JSON.parse(String(data));
      if (envelope.type !== "cf_agent_use_chat_response" || envelope.id !== requestId) return;
      const chunk = JSON.parse(envelope.body);
      if (chunk.type === "text-delta") { ttft ??= Date.now() - started; text += chunk.delta; }
      if (chunk.type === "error") error = chunk.errorText;
      if (envelope.done) { socket.off("message", onMessage); resolve({ ttft, total: Date.now() - started, text, error }); }
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ id: requestId, type: "cf_agent_use_chat_request", init: { method: "POST", body: JSON.stringify({ messages, trigger: "submit-message" }) } }));
  });
  return { socket, call, ask };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, value, i, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[i + 1]]] : pairs), []),
  );
  const server = args.server || "http://127.0.0.1:8787";
  const runs = Number(args.runs || 5);
  // The overlay opens its room at startup or when a session starts, well before the first question;
  // --settle models that gap (ms between opening the room and asking). 0 measures a cold room.
  const settle = Number(args.settle || 0);
  const base = decodePng(readFileSync(args.image || new URL("../test/fixtures/screen-probe.png", import.meta.url)));
  const hidden = contextMessage("Answer Them's last question for me, using my screen and the conversation.");

  const results = [];
  let failures = 0;
  for (let i = 0; i < runs; i++) {
    const room = await openRoom(server);
    if (settle) await new Promise((resolve) => setTimeout(resolve, settle));
    const messageId = randomUUID();
    const png = encodePng(withNonce(base, i + Date.now()));
    const uploadStarted = Date.now();
    await room.call("uploadScreenshot", { messageId, dataBase64: png.toString("base64"), contentType: "image/png" });
    const upload = Date.now() - uploadStarted;
    const first = { id: messageId, role: "user", parts: [{ type: "text", text: hidden }] };
    const answer = await room.ask([first]);
    const usesScreen = /812[.,]40|4471/.test(answer.text);
    const usesTranscript = /thursday/i.test(answer.text);
    const followMessages = [first, { id: randomUUID(), role: "assistant", parts: [{ type: "text", text: answer.text }] },
      { id: randomUUID(), role: "user", parts: [{ type: "text", text: "Them: and that total in euros, roughly, at 0.92 per dollar?" }] }];
    const follow = await room.ask(followMessages);
    room.socket.close();
    const ok = usesScreen && usesTranscript && !answer.error && !follow.error;
    if (!ok) failures++;
    results.push({ run: i + 1, upload_ms: upload, ttft_ms: answer.ttft, total_ms: answer.total, followup_ttft_ms: follow.ttft, screen: usesScreen, transcript: usesTranscript, error: answer.error || follow.error });
    console.log(`run ${i + 1}: upload ${upload} ms  ttft ${answer.ttft} ms  total ${answer.total} ms  follow-up ttft ${follow.ttft} ms  screen=${usesScreen} transcript=${usesTranscript}${ok ? "" : `  ANSWER: ${JSON.stringify((answer.error || answer.text).slice(0, 200))}`}`);
  }
  const p50 = (key) => { const v = results.map((r) => r[key]).filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
  const summary = { runs, ttft_p50_ms: p50("ttft_ms"), total_p50_ms: p50("total_ms"), followup_ttft_p50_ms: p50("followup_ttft_ms"), upload_p50_ms: p50("upload_ms"), context_failures: failures };
  console.log(JSON.stringify(summary));
  process.exit(failures ? 1 : 0);
}

// ---- minimal PNG codec (8-bit RGB/RGBA, non-interlaced): enough to give each run fresh pixels ----

export function decodePng(buf) {
  let pos = 8, width = 0, height = 0, channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0 || ![2, 6].includes(data[9])) throw new Error("bench needs an 8-bit RGB/RGBA non-interlaced PNG");
      channels = data[9] === 6 ? 4 : 3;
    }
    if (type === "IDAT") idat.push(data);
    pos += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      pixels[y * stride + x] = (line[x] + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

export function withNonce(image, nonce) {
  const pixels = Buffer.from(image.pixels);
  const stride = image.width * image.channels;
  // A 48x24 block of nonce-coloured pixels in the top-right corner: invisible to the question,
  // different bytes for any image cache.
  for (let y = 8; y < 32; y++) for (let x = image.width - 56; x < image.width - 8; x++) {
    const at = y * stride + x * image.channels;
    pixels[at] = (nonce * 37) & 255; pixels[at + 1] = (nonce * 91 + x) & 255; pixels[at + 2] = (nonce * 13 + y) & 255;
  }
  return { ...image, pixels };
}

export function encodePng({ width, height, channels, pixels }) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (data) => { let c = 0xffffffff; for (const byte of data) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

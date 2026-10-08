#!/usr/bin/env node
// Drive a running overlay over the Chrome DevTools protocol (start it with CUE_DEBUG_PORT=9333).
// Content protection hides the overlay from macOS screenshots; CDP captures the page itself.
//   node scripts/drive.mjs js "document.title"                   print the value
//   node scripts/drive.mjs wait "!!document.querySelector('.x')" [timeoutMs]
//   node scripts/drive.mjs shot out.png                          screenshot the page
//   --port 9333 (default)   --page settings   (match a target whose URL contains this)
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv.splice(i, 2)[1] : fallback; };
const port = flag("port", process.env.CUE_DEBUG_PORT || "9333");
const pageMatch = flag("page", "");
const [command, arg, extra] = argv;

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const target = targets.find((t) => t.type === "page" && (pageMatch ? t.url.includes(pageMatch) : !t.url.includes("settings")));
if (!target) throw new Error(`no page target${pageMatch ? ` matching ${pageMatch}` : ""}: ${targets.map((t) => t.url).join(", ")}`);
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
let nextId = 1;
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  const onMessage = (data) => {
    const message = JSON.parse(data);
    if (message.id !== id) return;
    socket.off("message", onMessage);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  };
  socket.on("message", onMessage);
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
};

if (command === "js") {
  const value = await evaluate(arg);
  console.log(typeof value === "string" ? value : JSON.stringify(value));
} else if (command === "wait") {
  const deadline = Date.now() + Number(extra || 60000);
  const started = Date.now();
  while (!(await evaluate(arg))) {
    if (Date.now() > deadline) { console.error(`timeout after ${Date.now() - started} ms: ${arg}`); process.exit(1); }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  console.log(`ok after ${Date.now() - started} ms`);
} else if (command === "shot") {
  // Keep the page's transparency so the capture can be composited like a real window capture.
  await call("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  const { data } = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(arg, Buffer.from(data, "base64"));
  console.log(arg);
} else {
  console.error("usage: drive.mjs js|wait|shot ...");
  process.exit(2);
}
socket.close();

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { applySavedSettings, config, foreignOrigin } from "./config.js";
import { stopAllClaudeSessions, stopClaudeLogin } from "./claude-backend.js";
import { Store } from "./store.js";
import { stopLocalServers, syncLocalServers } from "./local-servers.js";
import { RpcError } from "./errors.js";
import { callRpc, userIdFromAuthorization } from "./rpc.js";
import { createAgentServer } from "./agent.js";

const store = new Store(config.dataFile);
// Launching with an explicit variable counts as choosing it in Settings, so the launcher (which
// starts llama-server only for the local backend) and the server never disagree.
for (const [key, name] of [["llmBackend", "CUE_LLM_BACKEND"], ["claudeModel", "CUE_CLAUDE_MODEL"], ["claudeEffort", "CUE_CLAUDE_EFFORT"], ["asrBackend", "CUE_ASR_BACKEND"]]) {
  if (process.env[name]) store.settings[key] = process.env[name];
}
applySavedSettings(store.settings, store.openApiKeys());
syncLocalServers();
const httpServer = createServer(handleRequest);
createAgentServer({ httpServer, store });

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".onnx", "application/octet-stream"],
  [".woff2", "font/woff2"],
]);

// The renderer loads Silero VAD and ONNX Runtime from here — pinned versions from node_modules, no
// CDN at runtime.
const vendorRoots = {
  "/vendor/vad/": join(process.cwd(), "node_modules/@ricky0123/vad-web/dist"),
  "/vendor/ort/": join(process.cwd(), "node_modules/onnxruntime-web/dist"),
};

async function handleRequest(request, response) {
  try {
    if (foreignOrigin(request)) return json(response, 403, { json: { message: "Forbidden origin" } });

    const url = new URL(request.url, `http://localhost:${config.port}`);
    if (url.pathname === "/health") return json(response, 200, { ok: true, service: "cue" });
    if (url.pathname === "/config") {
      return json(response, 200, {
        inactivityMs: config.inactivityMs,
        inactivityConfirmMs: config.inactivityConfirmMs,
        // The local VLM sees ~512 vision tokens (~960 px wide); Claude downsizes past ~1568 px.
        screenshotMaxSide: config.llmBackend === "local" ? 1280 : 1568,
      });
    }

    if (url.pathname === "/rpc" || url.pathname.startsWith("/rpc/")) {
      if (request.method !== "POST") return json(response, 405, { json: { message: "Method not allowed" } });
      const body = await readJson(request);
      const procedure = decodeURIComponent(url.pathname.replace(/^\/rpc\//, ""));
      const user = store.user(userIdFromAuthorization(request.headers.authorization || ""));
      const result = await callRpc(store, procedure, body, user);
      store.save();
      return json(response, 200, { json: result });
    }

    const agentMessages = url.pathname.match(/^\/agents\/chat-agent\/([^/]+)\/get-messages$/);
    if (agentMessages) {
      const room = store.room(decodeURIComponent(agentMessages[1]));
      return json(response, 200, room?.messages || []);
    }

    if (url.pathname.startsWith("/uploads/") && request.method === "PUT") {
      const key = decodeURIComponent(url.pathname.slice("/uploads/".length));
      // Upload slots are minted by storage/generateUploadUrl (modes/<uuid>) and held in memory;
      // a self-invented key is not stored however well-formed it looks.
      if (!/^modes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key) || !store.issuedUploads.has(key)) {
        request.resume();
        return json(response, 404, { json: { message: "Unknown upload key" } });
      }
      if (store.uploads.size >= 64) {
        request.resume();
        return json(response, 429, { json: { message: "Too many pending uploads" } });
      }
      // Reject an over-limit upload from its declared size, cleanly, before reading the body — a
      // mid-stream destroy surfaces to the client as a connection reset, not a readable error.
      const declared = Number(request.headers["content-length"] || 0);
      if (declared > config.maxUploadBytes) {
        request.resume();
        return json(response, 413, { json: { message: `File too large: ${declared} bytes exceeds the ${config.maxUploadBytes}-byte limit` } });
      }
      const bytes = await readBody(request, config.maxUploadBytes);
      store.uploads.set(key, bytes);
      return json(response, 200, { ok: true, bytes: bytes.length });
    }

    return serveStatic(url.pathname, response);
  } catch (error) {
    if (error instanceof RpcError) {
      return json(response, error.status, {
        json: {
          defined: false,
          code: error.code,
          status: error.status,
          message: error.message,
          data: error.data || { formErrors: [], fieldErrors: {} },
        },
      });
    }
    console.error("[cue]", error);
    return json(response, 500, {
      json: { defined: false, code: "INTERNAL_SERVER_ERROR", status: 500, message: "Internal server error" },
    });
  }
}

async function serveStatic(pathname, response) {
  const vendor = Object.keys(vendorRoots).find((prefix) => pathname.startsWith(prefix));
  const root = vendor ? vendorRoots[vendor] : join(process.cwd(), "public");
  const relative = vendor ? pathname.slice(vendor.length) : pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = normalize(join(root, relative));
  if (file !== root && !file.startsWith(root + sep)) return json(response, 404, { message: "Not found" });
  try {
    const data = await readFile(file);
    response.writeHead(200, {
      "content-type": contentTypes.get(extname(file)) || "application/octet-stream",
      "cache-control": "no-store",
    });
    return response.end(data);
  } catch {
    return json(response, 404, { message: "Not found" });
  }
}

function readJson(request) {
  const bytes = readBody(request, 10 * 1024 * 1024);
  return bytes.then((buffer) => {
    if (!buffer.length) return {};
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new RpcError({ code: "INPUT_VALIDATION_FAILED", status: 422, message: "Invalid JSON body" });
    }
  });
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new RpcError({ code: "PAYLOAD_TOO_LARGE", status: 413, message: "Payload too large" }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopAllClaudeSessions();
    stopClaudeLogin();
    stopLocalServers();
    store.saveNow();
    process.exit(0);
  });
}

httpServer.listen(config.port, config.host, () => {
  console.log(`Cue listening on http://${config.host}:${config.port}`);
  const chat = { claude: `claude CLI (${config.claudeModel})`, anthropic: `${config.anthropicBaseUrl || "Anthropic API"} (${config.claudeModel})` }[config.llmBackend];
  console.log(`  chat  -> ${config.llmBackend}: ${chat || `${config.llmBaseUrl} (${config.chatModel})`}`);
  console.log(`  asr   -> ${config.asrBaseUrl} (${config.transcriptionModel})`);
  console.log(`  store -> ${config.dataFile}`);
});

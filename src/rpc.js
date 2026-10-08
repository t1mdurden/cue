import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { applySavedSettings, backends, claudeEfforts, claudeModelId, claudeModels, config, endpointPresets, envDefaults, keyNames, keyStatus, keys } from "./config.js";
import { claudeAuthStatus, claudeLoginError, startClaudeLogin, stopAllClaudeSessions } from "./claude-backend.js";
import { RpcError, validationError } from "./errors.js";
import { listEndpointModels, testChat, transcribe } from "./providers.js";
import { extractText } from "./extract.js";
import { modeTemplates } from "./modeTemplates.js";
import { cancelDownload, catalogue, downloadStatus, listRepo, recommendedModel, resolveModel, startDownload, whisperModel } from "./models.js";
import { imageTokens, localServerStatus, syncLocalServers } from "./local-servers.js";
import { existsSync } from "node:fs";
import { totalmem } from "node:os";

export function userIdFromAuthorization(header = "") {
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new RpcError({ code: "UNAUTHORIZED", status: 401, message: "Unauthorized" });
  const payload = decodeJwtPayload(token);
  const subject = payload?.sub || token;
  return `user_${createHash("sha256").update(subject).digest("hex").slice(0, 24)}`;
}

function decodeJwtPayload(token) {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export async function callRpc(store, procedure, body, user) {
  const input = body?.json;
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
    throw validationError({ json: ["Invalid input: expected an object"] });
  }
  const [namespace, method] = procedure.split("/");
  if (!namespace || !method) throw new RpcError({ code: "NOT_FOUND", status: 404, message: "Unknown procedure" });

  if (namespace === "sessions") return sessionRpc(store, method, input, user);
  if (namespace === "modes") return modeRpc(store, method, input, user);
  if (namespace === "tags") return tagRpc(store, method, input, user);
  if (namespace === "sessionTags") return sessionTagRpc(store, method, input, user);
  if (namespace === "modeFiles") return modeFileRpc(store, method, input, user);
  if (namespace === "storage") return storageRpc(store, method, input);
  if (namespace === "userConfigs") return userConfigRpc(store, method, input, user);
  if (namespace === "settings") return settingsRpc(store, method, input);
  if (namespace === "models") return modelsRpc(method, input);
  if (namespace === "transcription") {
    if (method !== "transcribe") throw unknown(procedure);
    if (typeof input?.wavBase64 !== "string" || typeof input?.language !== "string") {
      throw validationError({
        wavBase64: [maybeString(input?.wavBase64)],
        language: [maybeString(input?.language)],
      });
    }
    const started = Date.now();
    const result = await transcribe(input);
    // Metrics only: transcript text must not land in logs/server.log as plaintext.
    console.log(`[asr] ${Date.now() - started}ms bytes=${input.wavBase64.length} chars=${result.text.length}`);
    return result;
  }
  throw unknown(procedure);
}

function sessionRpc(store, method, input = {}, user) {
  switch (method) {
    case "create": {
      const errors = {};
      if (input.meetingId !== undefined && input.meetingId !== null
        && (typeof input.meetingId !== "string" || input.meetingId.length > 200)) errors.meetingId = ["Expected string of at most 200 chars, or null"];
      if (Object.keys(errors).length) throw validationError(errors);
      return store.createSession(user, input);
    }
    case "createAmbientChatAgent": {
      if (input.isMobile !== undefined && typeof input.isMobile !== "boolean") {
        throw validationError({ isMobile: ["Expected boolean"] });
      }
      return store.createAmbientChatAgent(user, input);
    }
    case "resume":
      return store.resumeSession(user, requireId(input).id);
    case "end":
      return store.endSession(user, requireId(input).id, requireTranscript(input.transcript || []));
    case "update": {
      const errors = {};
      if (input.transcript !== undefined) input.transcript = requireTranscript(input.transcript);
      if (input.title !== undefined && (typeof input.title !== "string" || input.title.length > 200)) errors.title = ["Expected string of at most 200 chars"];
      if (Object.keys(errors).length) throw validationError(errors);
      return store.updateSession(user, input);
    }
    case "sendHeartbeat": {
      const session = user.sessions.find((s) => s.id === input?.id);
      if (session) session.lastHeartbeatAt = new Date().toISOString();
      return { ok: true };
    }
    case "waitFor": {
      const session = user.sessions.find((s) => s.id === input?.id);
      if (!session) throw notFound("Session");
      if (input?.state === "finished") return { status: session.state === "finished" ? "fulfilled" : "pending" };
      if (input?.event === "has-title") return { status: session.title && session.title !== "Audio session" ? "fulfilled" : "pending" };
      return { status: session.state === "analyzing" ? "pending" : "fulfilled" };
    }
    case "get": {
      const session = user.sessions.find((s) => s.id === input?.id);
      if (!session) throw notFound("Session");
      return session;
    }
    case "list": {
      const limit = Number(input?.limit || 12);
      let sessions = user.sessions;
      if (input?.state) sessions = sessions.filter((session) => session.state === input.state);
      if (input?.createdAfter) {
        const createdAfter = Date.parse(input.createdAfter);
        if (!Number.isNaN(createdAfter)) {
          sessions = sessions.filter((session) => Date.parse(session.createdAt) >= createdAfter);
        }
      }
      if (Array.isArray(input?.tagIds)) {
        const ids = new Set(input.tagIds);
        sessions = sessions.filter((session) => session.tags.some((tag) => ids.has(tag.id)));
      }
      const items = sessions.slice(0, limit).map(publicSession);
      return { items, nextCursor: null, total: user.sessions.length };
    }
    case "delete": {
      const index = user.sessions.findIndex((s) => s.id === input?.id);
      if (index >= 0) user.sessions.splice(index, 1);
      return { ok: true };
    }
    default:
      throw unknown(`sessions/${method}`);
  }
}

function tagRpc(store, method, input = {}, user) {
  if (method === "create") {
    const errors = {};
    if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 100)) errors.name = ["Expected string of at most 100 chars"];
    if (input.color !== undefined && (typeof input.color !== "string" || input.color.length > 32)) errors.color = ["Expected string of at most 32 chars"];
    if (Object.keys(errors).length) throw validationError(errors);
    return store.createTag(user, input);
  }
  if (method === "list") return user.tags;
  if (method === "delete") return store.deleteTag(user, requireId(input).id);
  throw unknown(`tags/${method}`);
}

function sessionTagRpc(store, method, input = {}, user) {
  if (method === "create") return store.addSessionTag(user, input);
  if (method === "delete") return store.deleteSessionTag(user, input);
  throw unknown(`sessionTags/${method}`);
}

function modeRpc(store, method, input = {}, user) {
  switch (method) {
    case "templates":
      return { items: modeTemplates };
    case "list": {
      const limit = Number(input?.limit || 100);
      const items = store.modes(user).slice(0, limit).map(publicMode);
      return { items, nextCursor: null, hasActiveMode: items.some((m) => m.isActive) };
    }
    case "get":
      return publicMode(store.mode(user, requireId(input).id));
    case "create": {
      const errors = {};
      if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 200)) errors.name = ["Expected string of at most 200 chars"];
      if (input.chatPrompt !== undefined && (typeof input.chatPrompt !== "string" || input.chatPrompt.length > 100_000)) errors.chatPrompt = ["Expected string of at most 100000 chars"];
      if (input.templateKey !== undefined && input.templateKey !== null
        && (typeof input.templateKey !== "string" || input.templateKey.length > 100)) errors.templateKey = ["Expected string of at most 100 chars, or null"];
      if (Object.keys(errors).length) throw validationError(errors);
      return publicMode(store.createMode(user, input));
    }
    case "update": {
      const mode = store.mode(user, requireId(input).id);
      if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 200)) throw validationError({ name: ["Expected string of at most 200 chars"] });
      if (input.chatPrompt !== undefined && (typeof input.chatPrompt !== "string" || input.chatPrompt.length > 100_000)) throw validationError({ chatPrompt: ["Expected string of at most 100000 chars"] });
      if (typeof input.name === "string") mode.name = input.name;
      if (typeof input.chatPrompt === "string") mode.chatPrompt = input.chatPrompt;
      mode.updatedAt = new Date().toISOString();
      return publicMode(mode);
    }
    case "delete":
      store.mode(user, requireId(input).id);
      user.modes = user.modes.filter((m) => m.id !== input.id);
      return { ok: true };
    case "setActive":
      return store.setActiveMode(user, requireId(input).id);
    case "setAllInactive":
      return store.setAllModesInactive(user);
    default:
      throw unknown(`modes/${method}`);
  }
}

async function modeFileRpc(store, method, input = {}, user) {
  const mode = store.mode(user, input?.modeId);
  if (method === "create") {
    const errors = {};
    if (typeof input?.modeId !== "string") errors.modeId = ["Invalid input: expected string"];
    if (input?.name !== undefined && (typeof input?.name !== "string" || input.name.length > 255)) errors.name = ["Expected string of at most 255 chars"];
    if (input?.contentType !== undefined && (typeof input?.contentType !== "string" || input.contentType.length > 100)) errors.contentType = ["Expected string of at most 100 chars"];
    if (typeof input?.storageKey !== "string" || !/^modes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.storageKey)) errors.storageKey = ["Expected an upload key from storage/generateUploadUrl"];
    if (Object.keys(errors).length) throw validationError(errors);
    // Extract text now, at upload, so the chat path reads a plain field instead of re-parsing.
    // Claim the upload before the (async) extraction, so the same slot cannot become two files.
    const bytes = store.uploads.get(input?.storageKey || "");
    store.uploads.delete(input?.storageKey || "");
    const text = bytes ? await extractText(input?.name || "file", input?.contentType || "", bytes) : "";
    const file = {
      id: randomUUID(),
      modeId: mode.id,
      name: input?.name || "file",
      storageKey: input?.storageKey || "",
      syncStatus: "synced",
      url: `/uploads/${encodeURIComponent(input?.storageKey || "")}`,
      text,
    };
    mode.files.push(file);
    const { text: _omit, ...rest } = file;
    return rest;
  }
  if (method === "getSyncStatus") return { status: "synced" };
  if (method === "delete") {
    mode.files = mode.files.filter((f) => f.id !== input?.id);
    return { ok: true };
  }
  throw unknown(`modeFiles/${method}`);
}

function storageRpc(store, method, input = {}) {
  if (method === "generateUploadUrl") {
    if (input.contentType !== undefined && (typeof input.contentType !== "string" || input.contentType.length > 100)) {
      throw validationError({ contentType: ["Expected string of at most 100 chars"] });
    }
    return store.generateUploadUrl(input.contentType);
  }
  throw unknown(`storage/${method}`);
}

// Default global shortcuts; Settings stores only the ones the person changed.
export const defaultShortcuts = {
  toggleVisibility: "CommandOrControl+\\",
  ask: "CommandOrControl+Enter",
  clear: "CommandOrControl+R",
  openSettings: "CommandOrControl+,",
  toggleSession: "CommandOrControl+Shift+\\",
  moveUp: "CommandOrControl+Up",
  moveDown: "CommandOrControl+Down",
  moveLeft: "CommandOrControl+Left",
  moveRight: "CommandOrControl+Right",
};
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export function effectiveSettings(store) {
  const saved = store.settings;
  return {
    contentProtection: saved.contentProtection ?? true,
    // Done once Setup finished; a store that already chose a backend before Setup existed counts.
    setupDone: saved.setupDone ?? Boolean(saved.llmBackend),
    llmBackend: config.llmBackend,
    chosen: config.chosen,
    localModel: config.localModel ?? null,
    claudeModel: config.claudeModel,
    claudeEffort: config.claudeEffort,
    claudeModels,
    claudeEfforts,
    openaiModel: config.openaiModel,
    compatibleBaseUrl: config.compatibleBaseUrl,
    compatibleModel: config.compatibleModel,
    endpointPresets,
    keys: Object.fromEntries(keyNames.map((name) => [name, keyStatus(name, Object.keys(store.openApiKeys()))])),
    keysRemembered: Boolean(store.atRestKey),
    asrBackend: config.asrBackend,
    asrBackends: ["local", "openai"],
    micDeviceId: saved.micDeviceId ?? null,
    shortcuts: { ...defaultShortcuts, ...saved.shortcuts },
    defaultShortcuts,
    backends,
    envDefaults,
    info: {
      version,
      chatModel: config.chatModel,
      llmBaseUrl: config.llmBaseUrl,
      asrBaseUrl: config.asrBaseUrl,
      localModel: resolveModel(config.localModel).label,
      imageTokens,
    },
  };
}

// Whether the model endpoints answer right now, for the About tab, the Model tab and the overlay's
// warning before a session; for the Claude backend that means whether the CLI is signed in.
async function modelStatus({ fresh = false } = {}) {
  const ping = async (base) => {
    if (base === "mock") return "mock";
    try {
      const health = base.replace(/\/v1\/?$/, "/health");
      const response = await fetch(health, { signal: AbortSignal.timeout(1500) });
      return response.ok ? "up" : `answered ${response.status}`;
    } catch {
      return "unreachable";
    }
  };
  if (config.llmBackend === "claude") {
    const [claude, asr] = await Promise.all([claudeAuthStatus({ fresh }), ping(config.asrBaseUrl)]);
    const loginError = claudeLoginError();
    return { chat: claudeChatStatus(claude), asr, claude: { ...claude, ...(loginError ? { loginError } : {}) } };
  }
  const servers = localServerStatus();
  if (!config.chosen) return { chat: "not chosen", asr: "not chosen", servers, chosen: false };
  const asr = await ping(config.asrBaseUrl);
  if (config.llmBackend === "anthropic") return { chat: keys.anthropic ? "key set" : "no key", asr, servers };
  if (config.llmBackend === "openai") return { chat: keys.openai ? "key set" : "no key", asr, servers };
  if (config.llmBackend === "compatible") return { chat: config.compatibleBaseUrl && config.compatibleModel ? "configured" : "not set", asr, servers };
  return { chat: await ping(config.llmBaseUrl), asr, servers };
}

// Local models: what fits this Mac, what a Hugging Face repo offers, downloads and their progress.
async function modelsRpc(method, input = {}) {
  if (method === "catalogue") {
    const ramGb = Math.round(totalmem() / 2 ** 30);
    return {
      ramGb,
      recommended: recommendedModel(ramGb),
      entries: catalogue.map((entry) => ({ ...entry, present: resolveModel(entry.id).files.every((file) => file.present) })),
      current: config.localModel ?? null,
      currentLabel: resolveModel(config.localModel).label,
      whisper: { present: existsSync(whisperModel.path), sizeGb: whisperModel.sizeGb },
    };
  }
  if (method === "repo") return listRepo(input.repo);
  if (method === "status") return { download: downloadStatus(), servers: localServerStatus() };
  if (method === "cancel") {
    cancelDownload();
    return downloadStatus();
  }
  if (method === "download") {
    // The chosen chat model's missing files, plus the speech model when it is missing too.
    const choice = input.choice === undefined ? config.localModel : validModelChoice(input.choice);
    const resolved = resolveModel(choice);
    const items = config.llmBackend !== "local" ? []
      : resolved.files.filter((file) => !file.present && file.url).map((file) => ({ url: file.url, path: file.path, sizeGb: sizeOf(file, choice) }));
    if (input.whisper !== false && config.asrBackend === "local" && !existsSync(whisperModel.path)) {
      items.push({ url: whisperModel.url, path: whisperModel.path, sizeGb: whisperModel.sizeGb });
    }
    if (!items.length) return { state: "done", label: resolved.label, done: 0, total: 0 };
    const label = config.llmBackend === "local" ? resolved.label : "the speech model";
    return startDownload(label, items, () => syncLocalServers());
  }
  throw unknown(`models/${method}`);
}

// Catalogue sizes are known; a Hugging Face pick carries the sizes its listing showed.
function sizeOf(file, choice) {
  const entry = catalogue.find((model) => model.id === choice || (model.repo === file.repo && [model.file, model.mmproj].includes(file.file)));
  if (entry) return file.role === "mmproj" ? 0 : entry.sizeGb;
  return Number(choice?.sizes?.[file.role]) || 0;
}

// A local model choice from Setup or Settings: a catalogue id, a Hugging Face { repo, file, mmproj },
// or a GGUF { path, mmproj } on this Mac. Anything else is refused before it reaches llama-server.
function validModelChoice(choice) {
  const gguf = (value) => typeof value === "string" && value.length < 300 && /\.gguf$/i.test(value);
  if (typeof choice === "string" && catalogue.some((model) => model.id === choice)) return choice;
  if (choice && typeof choice === "object") {
    const label = typeof choice.label === "string" ? choice.label.slice(0, 120) : undefined;
    const sizes = choice.sizes && typeof choice.sizes === "object" ? { model: Number(choice.sizes.model) || 0, mmproj: Number(choice.sizes.mmproj) || 0 } : undefined;
    if (typeof choice.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(choice.repo) && gguf(choice.file) && !/[\\]|\.\./.test(choice.file)
      && (choice.mmproj === undefined || choice.mmproj === null || (gguf(choice.mmproj) && !/[\\]|\.\./.test(choice.mmproj)))) {
      return { repo: choice.repo, file: choice.file, ...(choice.mmproj ? { mmproj: choice.mmproj } : {}), ...(label ? { label } : {}), ...(sizes ? { sizes } : {}) };
    }
    if (gguf(choice.path) && choice.path.startsWith("/") && existsSync(choice.path)
      && (!choice.mmproj || (gguf(choice.mmproj) && choice.mmproj.startsWith("/") && existsSync(choice.mmproj)))) {
      return { path: choice.path, ...(choice.mmproj ? { mmproj: choice.mmproj } : {}), ...(label ? { label } : {}) };
    }
  }
  throw validationError({ localModel: ["Expected a catalogue id, { repo, file, mmproj } from Hugging Face, or { path, mmproj } of .gguf files on this Mac"] });
}

function claudeChatStatus(auth) {
  if (auth.state === "signed-in") return "signed in";
  if (auth.state === "signed-out") return "not signed in";
  if (auth.state === "missing") return "claude CLI not installed";
  if (auth.state === "outdated") return `claude CLI too old: ${auth.detail}`;
  return `sign-in check failed: ${auth.detail}`;
}

function settingsRpc(store, method, input = {}) {
  if (method === "get") return effectiveSettings(store);
  if (method === "status") return modelStatus({ fresh: input.fresh === true });
  if (method === "claudeLogin") {
    startClaudeLogin();
    return { started: true };
  }
  // One tiny answer through the chosen backend: Setup's proof that the choice works before the
  // overlay depends on it.
  if (method === "test") return testChat();
  // The models an OpenAI-wire endpoint offers, so the person picks from a list instead of guessing.
  if (method === "endpointModels") {
    const backend = input.backend === "openai" ? "openai" : "compatible";
    return listEndpointModels({
      baseUrl: backend === "openai" ? undefined : String(input.baseUrl || config.compatibleBaseUrl),
      key: typeof input.key === "string" && input.key ? input.key : keys[backend],
      backend,
    });
  }
  if (method !== "update") throw unknown(`settings/${method}`);
  // Validate the whole patch into a candidate first: a rejected request must not leave half of it
  // applied (and then persisted by the next successful RPC's store.save()).
  const errors = {};
  const candidate = { ...store.settings };
  const choice = (key, allowed) => {
    if (input[key] === undefined) return;
    if (!allowed.includes(input[key])) errors[key] = [`Expected one of ${allowed.join(", ")}`];
    else candidate[key] = input[key];
  };
  choice("llmBackend", backends);
  if (input.claudeModel !== undefined) input = { ...input, claudeModel: claudeModelId(input.claudeModel) };
  choice("claudeModel", claudeModels.map((model) => model.id));
  choice("claudeEffort", claudeEfforts);
  choice("asrBackend", ["local", "openai"]);
  const text = (key, max, pattern) => {
    if (input[key] === undefined) return;
    if (typeof input[key] !== "string" || input[key].length > max || (pattern && input[key] && !pattern.test(input[key]))) errors[key] = [`Expected ${pattern ? "a valid value" : "a string"} of at most ${max} chars`];
    else candidate[key] = input[key].trim();
  };
  text("openaiModel", 200);
  text("compatibleModel", 200);
  text("compatibleBaseUrl", 500, /^https?:\/\/[^\s]+$/);
  if (input.localModel !== undefined) {
    try { candidate.localModel = validModelChoice(input.localModel); } catch (error) { Object.assign(errors, error.data?.fieldErrors || { localModel: [error.message] }); }
  }
  if (input.setupDone !== undefined) {
    if (typeof input.setupDone !== "boolean") errors.setupDone = ["Expected boolean"];
    else candidate.setupDone = input.setupDone;
  }
  // { anthropic: "sk-…" } sets a key, { anthropic: null } forgets it. Keys are never echoed back.
  const keyUpdates = [];
  if (input.apiKeys !== undefined) {
    const entries = input.apiKeys && typeof input.apiKeys === "object" ? Object.entries(input.apiKeys) : null;
    if (!entries || entries.some(([name, value]) => !keyNames.includes(name) || (value !== null && (typeof value !== "string" || value.length > 500 || /\s/.test(value.trim()))))) {
      errors.apiKeys = [`Expected { ${keyNames.join(" | ")}: key or null }`];
    } else {
      keyUpdates.push(...entries.map(([name, value]) => [name, value?.trim() || null]));
    }
  }
  if (input.contentProtection !== undefined) {
    if (typeof input.contentProtection !== "boolean") errors.contentProtection = ["Expected boolean"];
    else candidate.contentProtection = input.contentProtection;
  }
  if (input.micDeviceId !== undefined) {
    if (input.micDeviceId !== null && typeof input.micDeviceId !== "string") errors.micDeviceId = ["Expected string or null"];
    else candidate.micDeviceId = input.micDeviceId;
  }
  if (input.shortcuts !== undefined) {
    const entries = Object.entries(input.shortcuts || {});
    if (entries.some(([action, accelerator]) => !Object.hasOwn(defaultShortcuts, action) || typeof accelerator !== "string" || !accelerator)) {
      errors.shortcuts = ["Expected { action: accelerator } for known actions"];
    } else {
      candidate.shortcuts = { ...store.settings.shortcuts, ...Object.fromEntries(entries) };
    }
  }
  if (Object.keys(errors).length) throw validationError(errors);
  store.settings = candidate;
  for (const [name, value] of keyUpdates) store.setApiKey(name, value);
  const modelChanged = ["llmBackend", "claudeModel", "claudeEffort"].some((key) => input[key] !== undefined && input[key] !== config[key]);
  applySavedSettings(store.settings, store.openApiKeys());
  if (modelChanged) stopAllClaudeSessions(); // rooms respawn on their next turn with the new choice
  if (["llmBackend", "asrBackend", "localModel"].some((key) => input[key] !== undefined)) syncLocalServers();
  store.save();
  return effectiveSettings(store);
}

function userConfigRpc(store, method, input = {}, user) {
  if (method === "get") return user.config;
  if (method === "update") {
    const errors = {};
    for (const key of ["displayLanguage", "audioInputLanguage"]) {
      if (input[key] !== undefined && (typeof input[key] !== "string" || input[key].length > 20)) errors[key] = ["Expected string of at most 20 chars"];
    }
    if (Object.keys(errors).length) throw validationError(errors);
    for (const key of ["displayLanguage", "audioInputLanguage"]) {
      if (typeof input[key] === "string") user.config[key] = input[key];
    }
    return user.config;
  }
  throw unknown(`userConfigs/${method}`);
}

function publicMode(mode) {
  return { ...mode, files: mode.files.map(({ text, ...rest }) => rest) };
}

function publicSession(session) {
  const { transcript, ...rest } = session;
  return { ...rest, transcriptLength: transcript.length };
}

function requireId(input = {}) {
  if (typeof input.id !== "string") {
    throw validationError({ id: ["Invalid input: expected string"] });
  }
  return input;
}

function maybeString(value) {
  return typeof value === "string"
    ? `Invalid input: expected string, received ${value}`
    : "Invalid input: expected string, received undefined";
}

// A transcript the client sends back: bounded, known shape, no surprise fields into the store.
function requireTranscript(value) {
  if (!Array.isArray(value) || value.length > 5000) {
    throw validationError({ transcript: ["Expected an array of at most 5000 entries"] });
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || !["me", "them"].includes(entry.role)
      || typeof entry.text !== "string" || entry.text.length > 20_000) {
      throw validationError({ transcript: ["Expected entries { role: me|them, text: string of at most 20000 chars }"] });
    }
    return {
      role: entry.role,
      text: entry.text,
      status: typeof entry.status === "string" && entry.status.length <= 20 ? entry.status : "pending",
      createdAt: typeof entry.createdAt === "string" && entry.createdAt.length <= 40 ? entry.createdAt : new Date().toISOString(),
    };
  });
}

function notFound(name) {
  return new RpcError({ code: "NOT_FOUND", status: 404, message: `${name} not found`, data: {} });
}

function unknown(procedure) {
  return new RpcError({ code: "NOT_FOUND", status: 404, message: `Unknown procedure: ${procedure}`, data: {} });
}

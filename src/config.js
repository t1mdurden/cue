// Where answers and transcripts come from. Five chat backends, chosen by the person (Setup or
// Settings → Model), never by which keys happen to be in the environment:
//   local       llama.cpp on this Mac, started by the server (src/llama.js) with the chosen model
//   claude      the Claude Code CLI on the person's subscription (src/claude-backend.js)
//   anthropic   the Anthropic API with the person's key (src/anthropic-backend.js)
//   openai      the OpenAI API with the person's key
//   compatible  any OpenAI-compatible endpoint: OpenRouter, Gemini, Ollama, LM Studio, a llama.cpp server
// local, openai and compatible share one OpenAI-wire code path (src/providers.js).
const openAIBase = "https://api.openai.com/v1";

// The Claude models Settings offers for both Claude backends, best first. Full IDs only: the CLI's
// aliases drift with its version, so an alias would silently change the model under an update.
// Measured 2026-10-08 through the subscription (scripts/eval-context.mjs, low effort, first word
// p50): Fable 1.6 s, Sonnet 2.3 s, Opus 2.8 s.
export const claudeModels = [
  { id: "claude-fable-5-1", label: "Fable 5.1", desc: "Best answers; fastest first word on the subscription" },
  { id: "claude-opus-5-5", label: "Opus 5.5", desc: "Deepest thinking; slow to start on hard questions" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", desc: "Fast all-rounder" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", desc: "Cheapest and shortest answers" },
];
export const claudeEfforts = ["low", "medium", "high"];
// Stores written before full IDs used the CLI's aliases, and one release listed a Haiku that does
// not exist; both keep loading as a real model.
const claudeAliases = { fable: "claude-fable-5-1", opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-4-5", "claude-haiku-5-5": "claude-haiku-4-5" };
export function claudeModelId(value) {
  return claudeAliases[value] || value;
}

// Ready-made endpoints for the "compatible" backend; the person can also type any URL.
export const endpointPresets = [
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true },
  { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true },
  { id: "ollama", label: "Ollama on this Mac", baseUrl: "http://127.0.0.1:11434/v1", needsKey: false },
  { id: "lmstudio", label: "LM Studio on this Mac", baseUrl: "http://127.0.0.1:1234/v1", needsKey: false },
];

// API keys live in memory here. The environment seeds them (Docker, scripts); keys typed into
// Settings are sealed into the store with the at-rest key (src/atrest.js) and loaded over these.
export const keyNames = ["anthropic", "openai", "compatible"];
const envKeys = {
  anthropic: process.env.ANTHROPIC_API_KEY || "",
  openai: process.env.OPENAI_API_KEY || "",
  compatible: process.env.CUE_LLM_API_KEY || "",
};
export const keys = { ...envKeys };

export const config = {
  port: Number(process.env.PORT || 8787),
  // Loopback only: any non-empty bearer token is accepted, so a LAN-facing socket would hand
  // transcripts to anyone on the network. Docker sets HOST=0.0.0.0 inside its own namespace.
  host: process.env.HOST || "127.0.0.1",
  dataFile: process.env.CUE_DATA_FILE ?? "data/store.json",
  // Remote backends are opt-in by explicit choice, never by key presence: an OPENAI_API_KEY in the
  // shell (exported for something else entirely) must not route the screen or the microphone to a
  // third party. Privacy is the product.
  llmBackend: process.env.CUE_LLM_BACKEND || "local",
  // Whether the person has picked a backend (Setup, Settings, or CUE_LLM_BACKEND). Until then local
  // is only the suggestion: no model server starts and nothing downloads.
  chosen: Boolean(process.env.CUE_LLM_BACKEND),
  claudeModel: claudeModelId(process.env.CUE_CLAUDE_MODEL) || "claude-fable-5-1",
  // Low effort cuts the model's deliberation before the first word: ~1.0 s vs ~1.6 s to the first
  // token with a full-screen image (sonnet, measured), same answers on the fixtures.
  claudeEffort: process.env.CUE_CLAUDE_EFFORT || "low",
  openaiModel: process.env.CUE_OPENAI_MODEL || "gpt-5.1",
  compatibleBaseUrl: "",
  compatibleModel: "",
  // The local backend's model: a catalogue id, { repo, file, mmproj } or { path, mmproj } (src/models.js).
  localModel: process.env.CUE_LOCAL_MODEL || undefined,
  // CUE_ANTHROPIC_BASE_URL sends the Anthropic backend elsewhere (tests use llama.cpp's /v1/messages).
  anthropicBaseUrl: process.env.CUE_ANTHROPIC_BASE_URL || "",
  // CUE_LLM_BASE_URL points the local backend at a server someone else runs (Cue then starts none),
  // and, when CUE_LLM_BACKEND=openai is set too, the openai backend at another OpenAI-wire server
  // with CUE_CHAT_MODEL as its model (a Docker default URL meant for the local backend must not hijack
  // an OpenAI choice made in Settings).
  get llmBaseUrl() {
    if (this.llmBackend === "openai") return (process.env.CUE_LLM_BACKEND === "openai" && process.env.CUE_LLM_BASE_URL) || openAIBase;
    if (this.llmBackend === "compatible") return this.compatibleBaseUrl.replace(/\/+$/, "");
    return process.env.CUE_LLM_BASE_URL || `http://127.0.0.1:${process.env.CUE_LLM_PORT || 8081}/v1`;
  },
  get llmApiKey() {
    return this.llmBackend === "openai" ? keys.openai : this.llmBackend === "compatible" ? keys.compatible : "";
  },
  get chatModel() {
    if (this.llmBackend === "openai") return (process.env.CUE_LLM_BACKEND === "openai" && process.env.CUE_CHAT_MODEL) || this.openaiModel;
    if (this.llmBackend === "compatible") return this.compatibleModel;
    return process.env.CUE_CHAT_MODEL || "local";
  },
  // Speech: "local" whisper.cpp (default) or "openai" with the stored OpenAI key.
  asrBackend: process.env.CUE_ASR_BACKEND || "local",
  get asrBaseUrl() {
    if (process.env.CUE_ASR_BASE_URL) return process.env.CUE_ASR_BASE_URL;
    return this.asrBackend === "openai" ? openAIBase : `http://127.0.0.1:${process.env.CUE_ASR_PORT || 8082}/v1`;
  },
  get asrApiKey() { return this.asrBackend === "openai" ? keys.openai : ""; },
  get transcriptionModel() {
    if (process.env.CUE_TRANSCRIPTION_MODEL) return process.env.CUE_TRANSCRIPTION_MODEL;
    return this.asrBackend === "openai" ? "gpt-4o-mini-transcribe" : "local";
  },
  // Inactivity: 6 min without transcript/message change, then 40 s to continue.
  inactivityMs: Number(process.env.CUE_INACTIVITY_MS || 360000),
  inactivityConfirmMs: Number(process.env.CUE_INACTIVITY_CONFIRM_MS || 40000),
  maxUploadBytes: 20 * 1024 * 1024,
};

export const backends = ["local", "claude", "anthropic", "openai", "compatible"];
const saveable = ["llmBackend", "claudeModel", "claudeEffort", "asrBackend", "openaiModel", "compatibleBaseUrl", "compatibleModel", "localModel"];
// Settings saved from the Settings window override the env defaults above for these keys. Env only
// seeds the first run; Settings shows the effective value.
export const envDefaults = Object.fromEntries(saveable.map((key) => [key, config[key]]));

// `openKeys` are the saved keys already unsealed by the store; a saved key wins over the env's.
export function applySavedSettings(saved = {}, openKeys = {}) {
  for (const key of saveable) config[key] = saved[key] ?? envDefaults[key];
  config.chosen = Boolean(saved.llmBackend || process.env.CUE_LLM_BACKEND);
  config.claudeModel = claudeModelId(config.claudeModel);
  if (!backends.includes(config.llmBackend)) config.llmBackend = envDefaults.llmBackend;
  for (const name of keyNames) keys[name] = openKeys[name] ?? envKeys[name];
}

// What Settings may show about a key: whether one is set, where it came from, its last 4 characters.
export function keyStatus(name, savedNames = []) {
  const value = keys[name];
  if (!value) return { set: false };
  return { set: true, source: savedNames.includes(name) ? "saved" : "environment", hint: value.length > 8 ? `…${value.slice(-4)}` : "" };
}

// Only Cue's own pages may talk to the app server from a browser: any non-empty bearer token is
// accepted, so a web page on another origin could otherwise read transcripts or flip settings.
// Requests with no Origin (the Electron main process, scripts, tests) come from local processes.
export function foreignOrigin(request) {
  const origin = request.headers.origin;
  return Boolean(origin) && origin !== `http://localhost:${config.port}` && origin !== `http://127.0.0.1:${config.port}`;
}

// "mock" swaps both providers for deterministic local stand-ins (tests, offline UI work).
export const isMock = (url) => url === "mock";

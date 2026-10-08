import { config, isMock } from "./config.js";
import { decodeWavBase64, wavDurationSeconds } from "./wav.js";
import { randomUUID } from "node:crypto";
import { claudeStreamChat, resetClaudeSession, warmClaudeSession } from "./claude-backend.js";
import { anthropicStreamChat } from "./anthropic-backend.js";

export async function transcribe({ wavBase64, language }) {
  const wav = decodeWavBase64(wavBase64);
  if (isMock(config.asrBaseUrl)) {
    return { text: "", provider: "local-mock", durationSeconds: wavDurationSeconds(wav) };
  }
  const form = new FormData();
  form.append("file", new Blob([wav.buffer], { type: "audio/wav" }), "audio.wav");
  form.append("model", config.transcriptionModel);
  const lang = String(language || "").split("-")[0];
  if (lang && lang !== "auto") form.append("language", lang);
  form.append("response_format", "json");
  const response = await reach(config.asrBaseUrl, "/audio/transcriptions", {
    method: "POST",
    headers: auth(config.asrApiKey),
    body: form,
  });
  const result = await response.json();
  return { text: String(result.text || "").trim(), provider: config.asrBaseUrl, model: config.transcriptionModel };
}

// messages: [{ role: "user"|"assistant", text, images?: [dataUrl] }]
// sessionKey: per-room id used by the Claude backend to resume one conversation.
// signal: aborted when the question is replaced or the overlay goes away; every backend stops at once.
export async function streamChat({ system, messages, sessionKey, signal }) {
  if (config.llmBackend === "claude") return claudeStreamChat({ system, messages, sessionKey, signal });
  if (config.llmBackend === "anthropic") return anthropicStreamChat({ system, messages, signal });
  if (isMock(config.llmBaseUrl)) return localChat(system, messages);
  if (config.llmBackend === "compatible" && (!config.compatibleBaseUrl || !config.compatibleModel)) {
    throw new Error("No endpoint chosen. Set its URL and model in Settings → Model.");
  }
  if (config.llmBackend === "openai" && !config.llmApiKey) throw new Error("No OpenAI API key. Add one in Settings → Model.");

  const response = await reach(config.llmBaseUrl, "/chat/completions", {
    method: "POST",
    signal,
    headers: { ...auth(config.llmApiKey), "content-type": "application/json" },
    body: JSON.stringify({
      model: config.chatModel,
      stream: true,
      // A small local model can fall into a repetition loop and generate for minutes (seen in the
      // interview eval: 5156 words of "I think I'm stuck"); no overlay answer needs more than this.
      ...(config.llmBackend === "local" ? { max_tokens: 1536 } : {}),
      messages: [{ role: "system", content: system }, ...messages.map(toProviderMessage)],
    }),
  });

  async function* generate() {
    for await (const event of sse(response.body)) {
      const delta = event.choices?.[0]?.delta?.content;
      if (delta) yield delta;
      if (event.error) throw new Error(`Model error: ${event.error.message || JSON.stringify(event.error)}`);
    }
  }
  return generate();
}

// Called when a room's socket opens, before its first question: the Claude backend starts the room's
// process; a local model evaluates the room's system prompt once so the first answer reuses it from
// the prompt cache instead of paying for it (~0.6 s of a 1.9 s first token on an M3 Pro).
export function warmChat({ system, sessionKey }) {
  if (config.llmBackend === "claude") return warmClaudeSession(sessionKey, system);
  if (config.llmBackend !== "local" || isMock(config.llmBaseUrl)) return;
  fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { ...auth(config.llmApiKey), "content-type": "application/json" },
    body: JSON.stringify({ model: config.chatModel, max_tokens: 1, messages: [{ role: "system", content: system }, { role: "user", content: "ok" }] }),
  }).catch(() => {});
}

// One tiny answer through the chosen backend, timed: Setup and Settings run it to prove a choice
// works (key accepted, model there, server up) before the overlay depends on it.
export async function testChat() {
  const started = Date.now();
  const sessionKey = `test-${randomUUID()}`;
  let text = "";
  let firstTokenMs = null;
  try {
    for await (const token of await streamChat({ system: "Reply with the single word OK.", messages: [{ role: "user", text: "Are you there?" }], sessionKey })) {
      firstTokenMs ??= Date.now() - started;
      text += token;
      if (text.length > 200) break;
    }
    return text.trim() ? { ok: true, firstTokenMs, ms: Date.now() - started, text: text.trim().slice(0, 200) } : { ok: false, error: "The model answered with nothing." };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  } finally {
    resetClaudeSession(sessionKey);
  }
}

// The model ids an OpenAI-wire endpoint lists at /models. For OpenAI itself only the chat models:
// its list also carries embeddings, speech and image models that cannot answer.
export async function listEndpointModels({ baseUrl, key, backend }) {
  const base = backend === "openai" ? "https://api.openai.com/v1" : String(baseUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) return { ok: false, error: "Enter the endpoint's URL first.", models: [] };
  let response;
  try {
    response = await fetch(`${base}/models`, { headers: auth(key), signal: AbortSignal.timeout(8000) });
  } catch (error) {
    return { ok: false, error: `Could not reach ${base} (${error.cause?.code || error.name}).`, models: [] };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, error: "The endpoint rejected the key.", models: [] };
  if (!response.ok) return { ok: false, error: `${base}/models answered ${response.status}.`, models: [] };
  const body = await response.json().catch(() => ({}));
  let models = (body.data || body.models || []).map((model) => String(model.id || model.name || "")).filter(Boolean);
  if (backend === "openai") models = models.filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/audio|realtime|tts|transcribe|image|search|embedding|instruct/.test(id));
  return { ok: true, models: [...new Set(models)].sort() };
}

// One non-streamed completion, for server-side jobs such as session titles.
// Each call gets its own throwaway key, so a Claude process never carries one job into the next.
export async function complete({ system, prompt }) {
  const sessionKey = `complete-${randomUUID()}`;
  let text = "";
  try {
    for await (const token of await streamChat({ system, messages: [{ role: "user", text: prompt }], sessionKey })) {
      text += token;
    }
  } finally {
    resetClaudeSession(sessionKey);
  }
  return text;
}

function toProviderMessage(message) {
  if (message.role === "assistant" || !message.images?.length) {
    return { role: message.role, content: message.text };
  }
  return {
    role: "user",
    content: [
      { type: "text", text: message.text },
      ...message.images.map((url) => ({ type: "image_url", image_url: { url } })),
    ],
  };
}

function auth(key) {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// Network failures and non-2xx responses both become one readable message naming the endpoint,
// because "fetch failed" or a JSON error body tells the person in the overlay nothing.
async function reach(base, path, init) {
  const name = base.startsWith("https://api.openai.com") ? "OpenAI" : base;
  let response;
  try {
    response = await fetch(`${base}${path}`, init);
  } catch (error) {
    throw new Error(`Could not reach ${name}${error.cause?.code ? ` (${error.cause.code})` : ""}.`);
  }
  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    let detail = body.slice(0, 300);
    try { detail = JSON.parse(body).error?.message || detail; } catch {}
    if (response.status === 401 || response.status === 403) throw new Error(`${name} rejected the API key. Check it in Settings → Model.`);
    throw new Error(`${name} answered ${response.status}: ${detail}`);
  }
  return response;
}

async function* sse(body) {
  let pending = "";
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data !== "[DONE]") {
          try { yield JSON.parse(data); } catch {}
        }
      }
    }
  }
}

function localChat(system, messages) {
  const last = messages.at(-1);
  const text = last?.text || "";
  const modeMarker = system.match(/reply with ([A-Z][A-Z0-9_-]{7,})/i);
  // Reflect how many images reached the model this turn, so tests can assert that attachments are
  // bound to their own message and not re-sent on later turns.
  const imageTag = last?.images?.length ? `[images:${last.images.length}] ` : "";
  const answer = modeMarker?.[1] || `${imageTag}[cue local] ${text.trim() || "No request supplied."}`;
  async function* generate() {
    for (const token of answer.match(/\S+\s*/g) || []) yield token;
  }
  return generate();
}

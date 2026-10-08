// The Anthropic API backend: the Messages API through the official SDK, with the person's own API
// key. The whole room history goes with every turn (the API is stateless); the system prompt and the
// history are cached, so a follow-up pays for its new text only.
import Anthropic from "@anthropic-ai/sdk";
import { config, keys } from "./config.js";

let client = null;
let clientFor = "";

function anthropic() {
  if (!keys.anthropic) throw new Error("No Anthropic API key. Add one in Settings → Model.");
  const signature = `${keys.anthropic}|${config.anthropicBaseUrl}`;
  if (!client || clientFor !== signature) {
    // One retry covers a dropped connection; a rejected key is not retried by the SDK at all, so a
    // wrong key fails within a second instead of hanging the overlay.
    client = new Anthropic({ apiKey: keys.anthropic, baseURL: config.anthropicBaseUrl || undefined, maxRetries: 1, timeout: 120_000 });
    clientFor = signature;
  }
  return client;
}

// "data:image/jpeg;base64,..." -> an image block.
function imageBlock(dataUrl) {
  const [, mediaType, data] = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl) || [];
  return { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: data || "" } };
}

function toAnthropicMessage(message) {
  if (message.role === "assistant" || !message.images?.length) return { role: message.role, content: message.text || " " };
  return { role: "user", content: [...message.images.map(imageBlock), { type: "text", text: message.text || " " }] };
}

function explain(error) {
  const where = config.anthropicBaseUrl || "the Anthropic API";
  if (error instanceof Anthropic.AuthenticationError) return new Error("Anthropic rejected the API key. Check it in Settings → Model.");
  if (error instanceof Anthropic.PermissionDeniedError) return new Error(`This API key may not use ${config.claudeModel}.`);
  if (error instanceof Anthropic.NotFoundError) return new Error(`${config.claudeModel} is not available to this API key.`);
  if (error instanceof Anthropic.RateLimitError) return new Error("Anthropic is rate-limiting this key. Wait a moment and ask again.");
  if (error instanceof Anthropic.APIConnectionError) {
    const code = error.cause?.code || error.cause?.cause?.code;
    return new Error(`Could not reach ${where}${code ? ` (${code})` : ""}.`);
  }
  if (error instanceof Anthropic.APIError) return new Error(`Anthropic answered ${error.status ?? "an error"}: ${error.message}`);
  return error;
}

export async function anthropicStreamChat({ system, messages, signal }) {
  const model = config.claudeModel;
  const params = {
    model,
    max_tokens: 16000,
    system,
    messages: messages.map(toAnthropicMessage),
    cache_control: { type: "ephemeral" },
    // Haiku 4.5 takes no effort setting; every other listed model does (thinking stays adaptive).
    ...(model.startsWith("claude-haiku-4") ? {} : { output_config: { effort: config.claudeEffort } }),
  };
  // On Anthropic's own API a declined answer is re-run on a model the server picks, inside the same
  // call. A server that only speaks the Messages wire (llama.cpp in tests) gets the plain request.
  const stream = config.anthropicBaseUrl
    ? anthropic().messages.stream(params, { signal })
    : anthropic().beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, { signal });

  async function* generate() {
    try {
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield event.delta.text;
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") yield "\n\n(Claude declined to answer this.)";
    } catch (error) {
      throw explain(error);
    }
  }
  return generate();
}

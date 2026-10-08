// Cue's renderer audio pipeline:
// 48 kHz PCM per role -> averaging resampler -> Silero (legacy) NonRealTimeVAD, one per role ->
// 16 kHz WAV per utterance -> transcription RPC. "me" is zeroed while "them" is speaking (echo
// suppression), at most 4 transcriptions run at once, and an utterance is force-ended at 20 s.
export const NATIVE_RATE = 48000;
const TARGET_RATE = 16000;
const MAX_IN_FLIGHT = 4;
const MAX_QUEUED_CHUNKS = 16;
const FORCE_END_MS = 20000;

let loading = null;
let inFlight = 0;
let chain = Promise.resolve();
const serial = (task) => {
  const next = chain.then(task, task);
  chain = next.catch(() => {});
  return next;
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

async function loadVad() {
  loading ??= (async () => {
    await loadScript("/vendor/ort/ort.min.js");
    window.ort.env.wasm.wasmPaths = "/vendor/ort/";
    window.ort.env.wasm.numThreads = 1;
    await loadScript("/vendor/vad/bundle.min.js");
  })();
  return loading;
}

class Resampler {
  constructor(frameSize) {
    this.frameSize = frameSize;
    this.buffer = [];
  }
  process(samples) {
    const frames = [];
    for (const sample of samples) {
      this.buffer.push(sample);
      if ((this.buffer.length * TARGET_RATE) / NATIVE_RATE >= this.frameSize) frames.push(this.frame());
    }
    return frames;
  }
  frame() {
    const out = new Float32Array(this.frameSize);
    let read = 0;
    for (let i = 0; i < this.frameSize; i++) {
      let sum = 0;
      let count = 0;
      const until = Math.min(this.buffer.length, ((i + 1) * NATIVE_RATE) / TARGET_RATE);
      for (; read < until; read++) {
        sum += this.buffer[read];
        count++;
      }
      out[i] = count ? sum / count : 0;
    }
    this.buffer = this.buffer.slice(read);
    return out;
  }
}

// hooks: { language(), sessionStartedAt(), transcribe(wavBase64, language) -> text,
//          add(entry), ready(entry, text), remove(entry), activity(role, speaking) }
export async function createAudioPipeline(hooks) {
  await loadVad();
  const roles = {};
  const voice = { me: false, them: false };
  // Echo suppression. Zeroing "me" only while "them" is speaking is not enough: "them"'s VAD flips
  // a few hundred ms after onset, so a mic that hears the speakers leaks the start of every sentence
  // as a duplicate "Me" entry (measured: "What is it?" on a Them sentence). So mic audio is held for
  // ECHO_DELAY_MS and zeroed against "them"'s speech spans, back-dated by ECHO_LEAD_MS.
  const ECHO_DELAY_MS = 700;
  const ECHO_LEAD_MS = 500;
  const ECHO_TAIL_MS = 300;
  const themSpans = [];
  const meDelay = [];
  const overlapsThem = (t0, t1) =>
    themSpans.some((span) => span.start <= t1 && (span.end === null || span.end + ECHO_TAIL_MS >= t0));
  const releaseMe = (all = false) => {
    const cutoff = Date.now() - ECHO_DELAY_MS;
    while (meDelay.length && (all || meDelay[0].t <= cutoff)) {
      const { t, samples } = meDelay.shift(); // chunk covers [t - duration, t]
      const echo = overlapsThem(t - (samples.length / NATIVE_RATE) * 1000, t);
      roles.me.push(echo ? new Float32Array(samples.length) : samples);
    }
    while (themSpans.length && themSpans[0].end !== null && themSpans[0].end < Date.now() - 30000) themSpans.shift();
  };
  const releaseTimer = setInterval(releaseMe, 50);

  for (const role of ["me", "them"]) roles[role] = await createRole(role);

  async function createRole(role) {
    const vad = await window.vad.NonRealTimeVAD.new({ redemptionMs: 300, preSpeechPadMs: 300 });
    const resampler = new Resampler(vad.frameSamples);
    const queue = [];
    const pending = new Set();
    let draining = false;
    let startedAt = null;
    let forceEnd = null;

    const setVoice = (speaking) => {
      if (role === "them" && speaking !== voice.them) {
        if (speaking) themSpans.push({ start: Date.now() - ECHO_LEAD_MS, end: null });
        else if (themSpans.length) themSpans.at(-1).end = Date.now();
      }
      voice[role] = speaking;
      hooks.activity?.(role, speaking);
    };
    const resetSegment = () => {
      startedAt = null;
      clearTimeout(forceEnd);
      forceEnd = null;
      setVoice(false);
    };

    const onEvent = (event) => {
      const { Message } = window.vad;
      if (event.msg === Message.SpeechStart) {
        startedAt = Date.now();
        forceEnd = setTimeout(() => vad.frameProcessor.endSegment(onEvent), FORCE_END_MS);
        setVoice(true);
      }
      if (event.msg === Message.VADMisfire) resetSegment();
      if (event.msg !== Message.SpeechEnd) return;
      const began = startedAt;
      resetSegment();
      if (!began || inFlight >= MAX_IN_FLIGHT) return;
      inFlight++;
      const wav = { wavBase64: wavBase64(event.audio, TARGET_RATE) };
      pending.add(wav);
      const entry = {
        role,
        createdAt: new Date(began).toISOString(),
        relativeMs: began - hooks.sessionStartedAt(),
        status: "transcribing",
        text: "",
      };
      hooks.add(entry);
      hooks
        .transcribe(wav.wavBase64, hooks.language())
        .then((text) => (text ? hooks.ready(entry, text) : hooks.remove(entry)))
        .catch((error) => {
          console.error("Transcription error:", error);
          hooks.remove(entry);
        })
        .finally(() => {
          inFlight--;
          pending.delete(wav);
        });
    };

    const drain = async () => {
      if (draining) return;
      draining = true;
      try {
        for (const chunk of queue.splice(0)) {
          for (const frame of resampler.process(chunk)) await serial(() => vad.frameProcessor.process(frame, onEvent));
        }
      } catch (error) {
        console.error("Error processing audio:", error);
      }
      draining = false;
      if (queue.length) drain();
    };

    return {
      push(samples) {
        if (queue.length < MAX_QUEUED_CHUNKS) queue.push(samples);
        drain();
      },
      // Close the open utterance and hand back every WAV still waiting on ASR, so Assist can
      // send what was just said before its text exists.
      takePending() {
        vad.frameProcessor.endSegment(onEvent);
        return [...pending].map((wav) => ({ role, wavBase64: wav.wavBase64 }));
      },
      reset() {
        vad.frameProcessor.reset();
        queue.length = 0;
        resetSegment();
      },
    };
  }

  return {
    push: (role, samples) => (role === "me" ? meDelay.push({ t: Date.now(), samples }) : roles[role]?.push(samples)),
    takePending: () => {
      releaseMe(true);
      return [...roles.me.takePending(), ...roles.them.takePending()];
    },
    stop: () => {
      clearInterval(releaseTimer);
      meDelay.length = 0;
      Object.values(roles).forEach((role) => role.reset());
    },
    inFlight: () => inFlight,
  };
}

// Microphone through getUserMedia; an AudioWorklet posts 48 kHz Float32 blocks.
export async function captureMicrophone(onSamples, deviceId) {
  const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  // The mic chosen in Settings may be unplugged (AirPods off): fall back to the system default.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...audio, deviceId: { exact: deviceId } } : audio })
    .catch((error) => {
      if (deviceId && (error.name === "OverconstrainedError" || error.name === "NotFoundError")) return navigator.mediaDevices.getUserMedia({ audio });
      throw error;
    });
  const context = new AudioContext({ sampleRate: NATIVE_RATE });
  const worklet = `registerProcessor("tap", class extends AudioWorkletProcessor {
    process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
  });`;
  await context.audioWorklet.addModule(URL.createObjectURL(new Blob([worklet], { type: "text/javascript" })));
  const node = new AudioWorkletNode(context, "tap");
  // The worklet posts 128-sample blocks (~375/s). Re-chunk to 50 ms like audiotee's stream, or the
  // 16-chunk queue cap (sized for native ~50 ms chunks) drops most mic audio.
  const chunk = new Float32Array(NATIVE_RATE / 20);
  let filled = 0;
  node.port.onmessage = (event) => {
    let block = event.data;
    while (block.length) {
      const take = Math.min(block.length, chunk.length - filled);
      chunk.set(block.subarray(0, take), filled);
      filled += take;
      block = block.subarray(take);
      if (filled === chunk.length) {
        onSamples(chunk.slice());
        filled = 0;
      }
    }
  };
  context.createMediaStreamSource(stream).connect(node);
  return async () => {
    node.port.onmessage = null;
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
  };
}

export function pcm16ToFloat32(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < out.length; i++) {
    const value = view.getInt16(i * 2, true);
    out[i] = value < 0 ? value / 32768 : value / 32767;
  }
  return out;
}

export function wavBase64(samples, sampleRate) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 32768 : clamped * 32767, true);
    offset += 2;
  }
  return base64(bytes);
}

export function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

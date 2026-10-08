# Third-party notices

Cue's own code is MIT-licensed (see LICENSE). These pieces come from others.

## Shipped in this repository or in Cue.app

| Component | Where | License |
|---|---|---|
| Inter typeface (The Inter Project Authors) | `public/fonts/` | SIL Open Font License 1.1, `public/fonts/OFL.txt` |
| Lucide icons | `public/icons.svg`, `public/index.html` | ISC |
| @ricky0123/vad-web, with the Silero VAD model | `node_modules`, served to the overlay | ISC (vad-web), MIT (Silero VAD) |
| ONNX Runtime Web (Microsoft) | `node_modules`, served to the overlay | MIT |
| ws | `node_modules` | MIT |
| Anthropic TypeScript SDK | `node_modules` | MIT |
| Electron | `client/node_modules`, the shell of Cue.app | MIT |

`native/system-audio.swift` looks up the System Audio Recording permission through macOS's private
TCC functions the way insidegui/AudioCap (BSD-2-Clause) demonstrates; the code is Cue's own.

## Installed or downloaded separately, not redistributed

| Component | How it gets there | License |
|---|---|---|
| llama.cpp (`llama-server`) | `brew install llama.cpp` | MIT |
| whisper.cpp (`whisper-server`) and its ggml models | `brew install whisper-cpp`; the model is downloaded in Setup | MIT |
| Qwen3-VL GGUF models (Qwen) | downloaded in Setup from Hugging Face | Apache-2.0 |
| Models picked from other Hugging Face repos | downloaded in Setup | the license of that repo |
| Claude Code CLI | installed by you | Anthropic's terms |

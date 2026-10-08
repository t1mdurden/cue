export function decodeWavBase64(value) {
  const buffer = Buffer.from(String(value), "base64");
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Invalid WAV");
  }
  return {
    buffer,
    sampleRate: buffer.readUInt32LE(24),
    channels: buffer.readUInt16LE(22),
    bitsPerSample: buffer.readUInt16LE(34),
    dataBytes: Math.max(0, buffer.length - 44),
  };
}

export function wavDurationSeconds(wav) {
  const bytesPerFrame = (wav.bitsPerSample / 8) * wav.channels;
  return bytesPerFrame ? wav.dataBytes / bytesPerFrame / wav.sampleRate : 0;
}

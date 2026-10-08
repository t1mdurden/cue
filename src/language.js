// The language to answer in. "auto" (Settings: Output language = Same as the question) means the
// language the interviewer just asked in, so a Russian question gets a Russian answer and an
// English one an English answer, even when the prepared answer the mode file supplies is in the
// other language — a small local model otherwise copies the language of whatever it is shown.
// Detection covers the two languages Cue's interviews run in; Settings can fix any listed one.
const NAMES = { en: "English", ru: "Russian", de: "German", es: "Spanish", fr: "French" };
// Words an English sentence is made of; tech terms ("Kafka", "setup", "cluster") are not evidence.
const ENGLISH = /\b(?:the|you|your|what|how|why|is|are|do|did|can|tell|about|would|could|have|was|were|we|me|it|this|that)\b/gi;

// Russian, English, or null when the text gives nothing to tell by. Russian speech keeps English
// tech terms in Latin letters, so any Cyrillic without English sentence words is Russian; with both,
// the larger share of letters decides ("Why did you leave Яндекс?" is English).
export function languageOf(text = "") {
  const cyrillic = (text.match(/[Ѐ-ӿ]/g) || []).length;
  const english = (text.match(ENGLISH) || []).length;
  if (cyrillic && !english) return NAMES.ru;
  if (english && !cyrillic) return NAMES.en;
  if (!cyrillic) return null;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return cyrillic >= latin ? NAMES.ru : NAMES.en;
}

// A fixed Settings language wins. With "auto": the interviewer's last line when it tells (they may
// have just switched language), else their last two lines together (a last segment of bare tech
// terms), else what the user typed, else the language this room answered in last time (a repeated
// Assist with no new speech).
export function replyLanguage(setting, { them = [], typed = "", previous = null } = {}) {
  const code = String(setting || "auto").split("-")[0];
  if (code !== "auto" && Object.hasOwn(NAMES, code)) return NAMES[code];
  return languageOf(them.at(-1)) || languageOf(them.slice(-2).join("\n")) || languageOf(typed) || previous;
}

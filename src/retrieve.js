// A mode file longer than PER_FILE_CHARS cannot ride in the prompt — 387 prepared answers are
// ~236k characters — so each turn gets the few sections that match what was just said or asked.
// BM25 over markdown sections (heading + body), or ~1,500-character paragraph runs for plain text.
// Words are cut to their first 6 letters so Russian endings and English plurals still meet
// ("ушли"/"ушёл", "answers"/"answer"); a heading counts twice, since a prepared answer's heading is
// the question it answers.
const K1 = 1.2;
const B = 0.75;
const RUN = 1500;         // a section longer than this is cut at line breaks into runs of about this size
// Summed IDF the matched topic words must reach: one word found in at most ~1 section in 12 of a
// large file (2.5), less for a short file where no word can be that rare (half of ln N).
const minEvidence = (sections) => Math.min(2.5, Math.log(sections) / 2);
const index = new WeakMap(); // file object -> its sections and term statistics, built on first use

// Words that carry no topic in either language, call small talk included ("can you hear me", "one
// second", "let's get started"); "about yourself" keeps "yourself", "о себе" keeps "себе".
const STOP = new Set(`a an the and or but if then so to of in on at for with from by as is are was were be been being do does
did done have has had i me my you your we us our they them their he she it its this that these those there here what which who
whom whose when where why how can could would should will shall may might must not no yes ok okay thanks thank please let lets
get got just also very really more most some any all about into over than too out up down well like know think say said tell
sure right so um uh и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от
меня еще нет о из ему когда даже ну ли если уже или ни быть был до вас вам там потом может они тут где есть надо для мы тебя их
чем была сам без будет ж тогда кто этот того этого какой какая какие этом тем чтобы сейчас были можно при об хоть после над
больше тот через эти нас про всего них много хорошо свою этой перед лучше том такой им более всегда конечно между давайте
спасибо скажите расскажите hi hello hey bye hear see sorry second moment minute time today started great good nice
cool perfect awesome morning afternoon evening everyone guys meeting call screen share audio video camera mic muted unmute back
wait hold internet connection dropped lagging give one meet привет слышно видно секунду минуту момент отлично хорошо супер начнем начать`.split(/\s+/));

const stems = (text) => (text.toLowerCase().replace(/ё/g, "е").match(/[\p{L}\p{N}]+/gu) || [])
  .filter((word) => word.length > 1 && !STOP.has(word))
  .map((word) => (/\d/.test(word) ? word : word.slice(0, 6))); // "p95", "service351" stay whole

// Cut an over-long section at line breaks (a CSV, a log, a Q&A list with no blank lines).
function runs(section) {
  if (section.text.length <= RUN * 1.5) return [section];
  const out = [];
  for (const line of section.text.split("\n")) {
    for (let i = 0; i < Math.max(1, line.length); i += RUN) {
      const piece = line.slice(i, i + RUN);
      const last = out.at(-1);
      if (last && last.text.length + piece.length < RUN) last.text += `\n${piece}`;
      else out.push({ title: out.length ? `${section.title} (cont.)` : section.title, text: piece });
    }
  }
  return out;
}

function sectionsOf(text) {
  const lines = text.split("\n");
  if (lines.some((line) => /^#{1,6}\s/.test(line))) {
    const sections = [];
    for (const line of lines) {
      if (/^#{1,6}\s/.test(line) || !sections.length) sections.push({ title: line.replace(/^#+\s*/, ""), lines: [line] });
      else sections.at(-1).lines.push(line);
    }
    return sections.map(({ title, lines: body }) => ({ title, text: body.join("\n").trim() }))
      .filter((s) => s.text.length > s.title.length + 5).flatMap(runs);
  }
  const sections = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const last = sections.at(-1);
    if (last && last.text.length + paragraph.length < RUN) last.text += `\n\n${paragraph}`;
    else sections.push({ title: paragraph.trim().split("\n")[0].slice(0, 80), text: paragraph });
  }
  return sections.flatMap(runs);
}

function indexOf(file) {
  let entry = index.get(file);
  if (entry) return entry;
  const sections = sectionsOf(file.text).map((section) => {
    const terms = [...stems(section.title), ...stems(section.title), ...stems(section.text)];
    const tf = new Map();
    for (const term of terms) tf.set(term, (tf.get(term) || 0) + 1);
    return { ...section, tf, length: terms.length };
  });
  const df = new Map();
  for (const section of sections) for (const term of section.tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  const avgLength = sections.reduce((n, s) => n + s.length, 0) / (sections.length || 1);
  entry = { sections, df, avgLength };
  index.set(file, entry);
  return entry;
}

// The best-matching sections across `files` for `query`, at most `limit` of them and `maxChars` in
// total. Only topic words count — not stop words, and not words in more than a third of the file's
// sections — and their summed IDF must reach MIN_EVIDENCE, so small talk ("can you hear me?")
// sends nothing; a section must also score within 70% of the best, so a clear hit travels alone.
export function relevantSections(files, query, { limit = 2, maxChars = 4000 } = {}) {
  const queryTerms = [...new Set(stems(query))];
  if (!queryTerms.length) return [];
  const scored = [];
  for (const file of files) {
    const { sections, df, avgLength } = indexOf(file);
    const topical = queryTerms.filter((term) => df.get(term) && df.get(term) <= Math.max(1, sections.length / 3));
    for (const section of sections) {
      let score = 0;
      let evidence = 0;
      for (const term of topical) {
        const f = section.tf.get(term);
        if (!f) continue;
        const idf = Math.log(1 + (sections.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
        evidence += idf;
        score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * section.length / avgLength));
      }
      if (evidence >= minEvidence(sections.length)) scored.push({ file: file.name, title: section.title, text: section.text, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  let used = 0;
  for (const section of scored) {
    if (picked.length === limit || maxChars - used < 200 || section.score < scored[0].score * 0.7) break;
    const text = section.text.length > maxChars - used ? `${section.text.slice(0, maxChars - used)}…` : section.text;
    picked.push({ ...section, text });
    used += text.length;
  }
  return picked;
}

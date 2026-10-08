// Pull plain text out of an uploaded mode file. A file within PER_FILE_CHARS goes into the system prompt whole (cached
// with it); a longer one — 387 prepared answers, a long spec — is kept whole and src/retrieve.js
// sends the sections that match each turn. Text and PDF cover the resume/notes case; other types
// degrade to a note rather than throwing.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const PER_FILE_CHARS = 12000;
const MAX_FILE_CHARS = 1_000_000;
const pdfHelper = process.env.CUE_PDF_TEXT ?? join(process.cwd(), "bin", "pdf-text");

export async function extractText(name, contentType, bytes) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  let text = "";
  if (ext === "pdf" || contentType === "application/pdf") {
    text = readable(await pdfKitText(bytes)) || readable(extractPdfText(bytes));
  } else if (isProbablyText(contentType, ext, bytes)) {
    text = bytes.toString("utf8");
  } else {
    return `[${name}: ${bytes.length} bytes of ${contentType || ext || "binary"} — text not extracted]`;
  }
  text = text.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > MAX_FILE_CHARS) text = `${text.slice(0, MAX_FILE_CHARS)}\n[truncated at ${MAX_FILE_CHARS} characters]`;
  return text || `[${name}: no extractable text]`;
}

// bin/pdf-text (macOS PDFKit, built from native/pdf-text.swift): exact text from CID-font PDFs.
// Async: a large PDF can take seconds, and the server keeps answering other rooms meanwhile.
function pdfKitText(bytes) {
  if (!pdfHelper || !existsSync(pdfHelper)) return Promise.resolve("");
  return new Promise((resolve) => {
    const child = spawn(pdfHelper, [], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => { clearTimeout(timer); resolve(""); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 ? Buffer.concat(chunks).toString("utf8").trim() : ""); });
    child.stdin.on("error", () => {});
    child.stdin.end(bytes);
  });
}

// The fallback reader decodes every stream, so a PDF with embedded fonts comes back as font bytes,
// about one in eight of them control characters; text people write (any script, symbols, emoji,
// Windows-1252 punctuation read as latin1) has almost none. Noise is dropped rather than fed to
// the model as "the user's resume".
function readable(text) {
  if (!text) return "";
  const control = text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g)?.length || 0;
  return control / text.length < 0.02 ? text : "";
}

function isProbablyText(contentType, ext, bytes) {
  if (contentType?.startsWith("text/")) return true;
  if (["txt", "md", "markdown", "csv", "json", "log", "rtf", "html", "xml", "yaml", "yml"].includes(ext)) return true;
  const sample = bytes.subarray(0, 1024);
  let control = 0;
  for (const byte of sample) if (byte === 0 || (byte < 9)) control++;
  return sample.length > 0 && control / sample.length < 0.05;
}

// Uncompressed PDF text: pull strings out of BT…ET text objects in each content stream. Handles
// the plain and FlateDecode cases most resume/notes PDFs use; returns "" when a PDF is all images.
function extractPdfText(bytes) {
  const raw = bytes.toString("latin1");
  const chunks = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;
  while ((match = streamRe.exec(raw))) {
    let body = match[1];
    if (/FlateDecode/.test(raw.slice(Math.max(0, match.index - 200), match.index))) {
      try {
        body = inflate(Buffer.from(body, "latin1")).toString("latin1");
      } catch {
        continue;
      }
    }
    chunks.push(decodePdfOperators(body));
  }
  return chunks.join("\n").replace(/[ \t]{2,}/g, " ").trim();
}

function decodePdfOperators(content) {
  const out = [];
  // (literal) Tj / TJ arrays, and \n between text-positioning operators.
  const tokenRe = /\((?:\\.|[^\\()])*\)|\bTd\b|\bTD\b|\bT\*\b|\bTj\b|\bTJ\b/g;
  let match;
  let line = "";
  while ((match = tokenRe.exec(content))) {
    const token = match[0];
    if (token.startsWith("(")) {
      line += unescapePdfString(token.slice(1, -1));
    } else if (token === "Td" || token === "TD" || token === "T*") {
      if (line.trim()) out.push(line.trim());
      line = "";
    }
  }
  if (line.trim()) out.push(line.trim());
  return out.join("\n");
}

function unescapePdfString(text) {
  return text.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, code) => {
    const map = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
    if (map[code] !== undefined) return map[code];
    return String.fromCharCode(parseInt(code, 8));
  });
}

import { inflateSync } from "node:zlib";
function inflate(buffer) {
  return inflateSync(buffer);
}

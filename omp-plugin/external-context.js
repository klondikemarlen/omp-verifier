import { createHash } from "node:crypto";

const MAX_EXTERNAL_SOURCE_BYTES = 256_000;
const MAX_EXCERPT_BYTES = 16_000;
const FETCH_TIMEOUT_MS = 10_000;

export function pinnedExternalSource(value) {
  if (typeof value !== "string") throw new Error("external context must be a pinned raw GitHub URL");
  const match = /^https:\/\/raw\.githubusercontent\.com\/([a-zA-Z0-9][\w.-]*)\/([a-zA-Z0-9][\w.-]*)\/([a-f0-9]{40})\/([\w./-]+)$/.exec(value);
  if (!match || match[4].split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("external context supports only https://raw.githubusercontent.com/<owner>/<repo>/<40-character-commit>/<path>; mutable refs, other hosts, credentials, query strings, and redirects are unsupported");
  }
  return { url: value, revision: match[3] };
}

export async function readExternalText(source, range) {
  let response;
  try {
    response = await fetch(source.url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return { error: `external source returned HTTP ${response.status}` };
    if (!response.body) return { error: "external source returned no body" };
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_EXTERNAL_SOURCE_BYTES) return { error: `external source exceeds the ${MAX_EXTERNAL_SOURCE_BYTES}-byte retrieval limit` };
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, size);
    if (bytes.includes(0)) return { error: "external source is not text" };
    const fullContent = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const lines = fullContent.split(/\r?\n/);
    const startLine = range?.startLine ?? 1;
    const endLine = range?.endLine ?? lines.length;
    if (startLine > lines.length || endLine > lines.length) return { error: "external context range is beyond end of source" };
    const content = range ? lines.slice(startLine - 1, endLine).join("\n") : fullContent;
    if (Buffer.byteLength(content) > MAX_EXCERPT_BYTES) {
      return { error: `external excerpt exceeds the ${MAX_EXCERPT_BYTES}-byte evidence limit; select a smaller original line range` };
    }
    return {
      content,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      lineCount: lines.length,
      startLine,
      endLine,
      partial: startLine !== 1 || endLine < lines.length,
    };
  } catch (error) {
    return { error: `external source capture failed: ${error.message}` };
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

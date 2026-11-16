import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

const MAX_EXCERPT_BYTES = 16_000;

// Scan the whole source for identity, but retain only the requested evidence.
export async function readSourceRange(path, range, maxScanBytes) {
  let file;
  try {
    file = await open(path, "r");
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) return { error: "path is not a regular file" };
    const scanError = { error: `file exceeds the ${maxScanBytes}-byte range scan limit`, sizeLimitExceeded: true };
    if (before.size > BigInt(maxScanBytes)) return scanError;

    const startLine = range.startLine;
    const requestedEndLine = range.endLine ?? startLine + 119;
    const excerptError = {
      error: `excerpt exceeds the ${MAX_EXCERPT_BYTES}-byte evidence limit; request a smaller line range`,
      rangeRecovery: true,
    };
    // Allow CRLF delimiters while buffering; the normalized excerpt has its own limit.
    const bufferLimit = MAX_EXCERPT_BYTES + 2 * (requestedEndLine - startLine + 1);
    const hash = createHash("sha256");
    const parts = [];
    let selectedBytes = 0;
    let size = 0;
    let lineCount = 1;
    let endsWithDelimiter = false;
    for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      size += chunk.length;
      if (size > maxScanBytes) return scanError;
      if (chunk.includes(0)) return { error: "file is not text" };
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline + 1;
        if (lineCount >= startLine && lineCount <= requestedEndLine) {
          selectedBytes += end - offset;
          if (selectedBytes > bufferLimit) return excerptError;
          parts.push(chunk.subarray(offset, end));
          endsWithDelimiter = newline !== -1;
        }
        if (newline !== -1) lineCount += 1;
        offset = end;
      }
    }
    const after = await file.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(size) !== after.size) {
      return { error: "source changed while the selected range was being captured" };
    }
    const endLine = range.endLine ?? Math.min(lineCount, requestedEndLine);
    if (startLine > lineCount) return { error: `requested line ${startLine} is beyond end of file`, rangeRecovery: true };
    if (endLine > lineCount) return { error: `requested line ${endLine} is beyond end of file`, rangeRecovery: true };

    let content = Buffer.concat(parts, selectedBytes).toString("utf8");
    // A delimiter after the selected last line is not part of that line. A final
    // empty line selected at EOF, however, retains its preceding delimiter.
    if (endsWithDelimiter && endLine < lineCount) content = content.replace(/\r?\n$/, "");
    content = content.replace(/\r\n/g, "\n");
    if (Buffer.byteLength(content) > MAX_EXCERPT_BYTES) return excerptError;
    return {
      content,
      sha256: hash.digest("hex"),
      size,
      lineCount,
      startLine,
      endLine,
      partial: startLine !== 1 || endLine < lineCount,
    };
  } catch (error) {
    return error?.code === "ENOENT" ? { missing: true } : { error: error.message };
  } finally {
    await file?.close();
  }
}

const MAX_TOTAL_EVIDENCE_BYTES = 256_000;
const MAX_EVIDENCE_FILES = 40;
const MAX_LARGE_SCOPE_EVIDENCE_BYTES = 1_024_000;
const MAX_LARGE_SCOPE_EVIDENCE_FILES = 256;

export class SemanticEvidenceBudget {
  #maxFiles;
  #maxBytes;
  #boundedBatch;
  #requiredFiles;
  #usedBytes = 0;
  #paths = new Set();
  #truncated = false;
  #records = [];
  #rejections = [];

  constructor({ requiredFiles, boundedBatch, continuationBundle }) {
    this.#requiredFiles = requiredFiles;
    this.#boundedBatch = boundedBatch;
    const largeScope = requiredFiles > MAX_EVIDENCE_FILES;
    this.#maxFiles = largeScope ? MAX_LARGE_SCOPE_EVIDENCE_FILES : MAX_EVIDENCE_FILES;
    this.#maxBytes = largeScope ? MAX_LARGE_SCOPE_EVIDENCE_BYTES : MAX_TOTAL_EVIDENCE_BYTES;
    if (boundedBatch) {
      const batchCapacity = continuationBundle ? 32 : 1;
      this.#maxFiles = MAX_LARGE_SCOPE_EVIDENCE_FILES * batchCapacity;
      this.#maxBytes = MAX_TOTAL_EVIDENCE_BYTES * batchCapacity;
    }
  }

  admit(records, record) {
    if (records.some(existing => existing.path === record.path
      && (existing.startLine ?? 1) === (record.startLine ?? 1)
      && existing.content === record.content)) {
      return true;
    }

    const bytes = Buffer.byteLength(record.content);

    // Optional discovery cannot itself grow the required-evidence allowance.
    const required = record.source !== "callers" && record.source !== "siblings";
    if (!this.#boundedBatch && required && this.#usedBytes + bytes > MAX_TOTAL_EVIDENCE_BYTES) {
      this.#maxFiles = MAX_LARGE_SCOPE_EVIDENCE_FILES;
      this.#maxBytes = MAX_LARGE_SCOPE_EVIDENCE_BYTES;
    }

    const exceedsFiles = !this.#paths.has(record.path) && this.#paths.size >= this.#maxFiles;
    const exceedsBytes = this.#usedBytes + bytes > this.#maxBytes;
    if (exceedsFiles || exceedsBytes) {
      const limits = [];
      if (exceedsFiles) limits.push(`${this.#maxFiles}-file evidence limit`);
      if (exceedsBytes) limits.push(`${this.#maxBytes}-byte evidence limit`);
      this.reject({
        path: record.path,
        source: record.source,
        bytes,
        reason: `${limits.join(" and ")} reached; ${this.#usedBytes} bytes across ${this.#paths.size} files already admitted`,
      });
      return false;
    }

    records.push(record);
    this.#paths.add(record.path);
    this.#usedBytes += bytes;
    this.#records.push({
      path: record.path,
      source: record.source,
      bytes,
      startLine: record.startLine ?? 1,
    });
    return true;
  }

  reject(rejection) {
    this.#rejections.push(rejection);
    this.#truncated = true;
  }

  get lastRejectionReason() {
    return this.#rejections.at(-1)?.reason;
  }

  get truncated() {
    return this.#truncated;
  }

  snapshot({ maxSourceBytes, maxContextPaths }) {
    return {
      ...(this.#boundedBatch ? { boundedBatch: true } : {}),
      maxBytes: this.#maxBytes,
      maxFiles: this.#maxFiles,
      requiredFiles: this.#requiredFiles,
      maxSourceBytes,
      ...(maxContextPaths === undefined ? {} : { maxContextPaths }),
      usedBytes: this.#usedBytes,
      usedFiles: this.#paths.size,
      records: this.#records,
      rejections: this.#rejections,
    };
  }
}

export function sourceEvidenceRecord(path, result, source) {
  return {
    path,
    state: "present",
    source,
    sha256: result.sha256,
    lineCount: result.lineCount ?? result.content.split(/\r?\n/).length,
    ...(result.startLine && result.startLine > 1 ? { startLine: result.startLine } : {}),
    ...(result.partial ? {
      partial: true,
      omittedRanges: [
        ...(result.startLine > 1 ? [[1, result.startLine - 1]] : []),
        ...(result.endLine < result.lineCount ? [[result.endLine + 1, result.lineCount]] : []),
      ],
    } : {}),
    content: result.content,
  };
}

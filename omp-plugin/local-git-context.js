import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function pinnedLocalGitSource(value) {
  const url = new URL(value);
  const revision = url.searchParams.get("revision");
  const filePath = url.searchParams.get("path");
  if (url.protocol !== "git+file:" || url.host || url.username || url.password || url.hash
    || url.searchParams.size !== 2
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision ?? "")
    || !filePath || isAbsolute(filePath) || /[\p{Cc}\\:]/u.test(filePath)
    || filePath.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("local Git context requires git+file:///absolute/repository?revision=<full-commit>&path=<repository-relative-file>; mutable refs, credentials, extra parameters, and traversal are unsupported");
  }
  const repositoryRoot = fileURLToPath(`file://${url.pathname}`);
  if (!isAbsolute(repositoryRoot)) throw new Error("local Git repository must be absolute");
  return {
    url: value,
    revision,
    repositoryRoot,
    filePath,
  };
}

export async function readLocalGitBytes(source, maxBytes) {
  const root = await realpath(source.repositoryRoot);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";

  async function git(args, maxBuffer = 4096) {
    const { stdout } = await execFileAsync("git", [
      "--no-replace-objects",
      "-c", "protocol.allow=never",
      "-c", "core.fsmonitor=false",
      "-C", root,
      ...args,
    ], {
      env,
      encoding: "buffer",
      timeout: 5000,
      maxBuffer,
    });
    return stdout;
  }

  const topLevel = await git(["rev-parse", "--show-toplevel"]);
  if (await realpath(topLevel.toString("utf8").trim()) !== root) {
    throw new Error("local Git context must select the repository root, not a nested directory");
  }
  const type = await git(["cat-file", "-t", source.revision]);
  if (type.toString("utf8").trim() !== "commit") {
    throw new Error("local Git revision must identify a commit object");
  }
  const tree = await git(["ls-tree", "-z", source.revision, "--", `:(literal)${source.filePath}`], 16_000);
  const entry = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/.exec(tree.toString("utf8"));
  if (!entry || entry[3] !== source.filePath) {
    throw new Error("selected Git path is missing or is not a regular committed file; symlinks, directories and submodules are unsupported");
  }
  const blobId = entry[2];
  const size = Number((await git(["cat-file", "-s", blobId])).toString("utf8").trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
    throw new Error(`local Git source exceeds the ${maxBytes}-byte retrieval limit`);
  }
  const bytes = await git(["cat-file", "blob", blobId], maxBytes + 1);
  const hashAlgorithm = blobId.length === 40 ? "sha1" : "sha256";
  const actualBlobId = createHash(hashAlgorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (bytes.length !== size || actualBlobId !== blobId) {
    throw new Error("local Git blob integrity does not match the selected commit");
  }
  return bytes;
}

import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 20_000;
const MAX_METADATA_BYTES = 2_000_000;
const MAX_RANGES_PER_PATH = 20_000;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

const DIFF_OPTIONS = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--ignore-submodules=none",
];

function gitOptions(repositoryRoot) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return {
    cwd: repositoryRoot,
    env: {
      ...inherited,
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
    timeout: GIT_TIMEOUT_MS,
  };
}

export async function deliveryGit(repositoryRoot, args) {
  const { stdout, stderr } = await execFileAsync("git", ["--literal-pathspecs", ...args], {
    ...gitOptions(repositoryRoot),
    encoding: "buffer",
    maxBuffer: MAX_METADATA_BYTES,
  });
  if (stderr.length) {
    throw new Error(`delivery Git scope: ${stderr.toString("utf8").trim()}`);
  }
  const text = stdout.toString("utf8");
  if (!Buffer.from(text).equals(stdout)) {
    throw new Error("delivery scope requires UTF-8 Git paths");
  }
  return text;
}

export function gitFields(output) {
  return output ? output.slice(0, -1).split("\0") : [];
}

export async function changedEntries(repositoryRoot, revisions, paths = []) {
  const output = await deliveryGit(repositoryRoot, [
    "diff", ...DIFF_OPTIONS, "--find-renames=50%", "-l1000", "--raw", "--no-abbrev", "-z", ...revisions, "--", ...paths,
  ]);
  const fields = gitFields(output);
  const entries = [];
  for (let index = 0; index < fields.length;) {
    const header = /^:(\d{6}) (\d{6}) ([\da-f]+) ([\da-f]+) ([ADMRT])\d*$/.exec(fields[index++]);
    const oldPath = fields[index++];
    if (!header || !oldPath) {
      throw new Error("delivery scope cannot read Git change metadata");
    }
    const [, oldMode, newMode, oldObject, newObject, status] = header;
    const path = status === "R" ? fields[index++] : oldPath;
    if (!path) {
      throw new Error("delivery scope cannot read Git rename destination");
    }
    entries.push({
      oldMode,
      newMode,
      oldObject,
      newObject,
      status,
      oldPath,
      path,
    });
  }
  return entries;
}

function recordRange(prefix, ranges) {
  const match = HUNK_HEADER.exec(prefix);
  if (!match) {
    throw new Error("delivery scope cannot read Git hunk coordinates");
  }
  const first = Number(match[1]);
  const count = Number(match[2] ?? 1);
  if (!count) {
    return;
  }
  const last = first + count - 1;
  if (!first || !Number.isSafeInteger(last) || ranges.length >= MAX_RANGES_PER_PATH) {
    throw new Error("delivery scope exceeds its Git hunk coordinate limits");
  }
  const previous = ranges.at(-1);
  if (previous && first <= previous[1] + 1) {
    previous[1] = Math.max(previous[1], last);
  } else {
    ranges.push([first, last]);
  }
}

async function readHunkRanges(stdout) {
  const ranges = [];
  let atLineStart = true;
  let hunkPrefix;
  for await (const chunk of stdout) {
    let begin = 0;
    while (begin < chunk.length) {
      const newline = chunk.indexOf(10, begin);
      const end = newline < 0 ? chunk.length : newline;
      // Quoted paths stay on their metadata line, and Git prefixes every
      // source line. Only an unprefixed hunk header starts with @.
      if (atLineStart) {
        hunkPrefix = chunk[begin] === 64 ? "" : undefined;
        atLineStart = false;
      }
      if (hunkPrefix !== undefined && hunkPrefix.length < 128) {
        hunkPrefix += chunk.toString("ascii", begin, Math.min(end, begin + 128 - hunkPrefix.length));
      }
      if (newline < 0) {
        break;
      }
      if (hunkPrefix !== undefined) {
        recordRange(hunkPrefix, ranges);
      }
      atLineStart = true;
      hunkPrefix = undefined;
      begin = newline + 1;
    }
  }
  if (hunkPrefix !== undefined) {
    recordRange(hunkPrefix, ranges);
  }
  return ranges;
}

export async function workingFileRanges(repositoryRoot, path, oldObject, reserveBytes) {
  const options = gitOptions(repositoryRoot);
  if (oldObject) {
    const size = Number(await deliveryGit(repositoryRoot, ["cat-file", "-s", oldObject]));
    if (!Number.isSafeInteger(size) || size > MAX_BLOB_BYTES) {
      throw new Error(`delivery scope cannot diff the oversized Git blob for ${path}`);
    }
    reserveBytes(size);
  }
  const args = [
    "-c", "core.quotePath=true", "diff", "--no-index", ...DIFF_OPTIONS, "--no-renames", "--text",
    "--unified=0", "--inter-hunk-context=0",
    "--diff-algorithm=myers", "--no-indent-heuristic", "--line-prefix=", "--output-indicator-new=+",
    "--output-indicator-old=-", "--output-indicator-context= ", "--", oldObject ? "-" : "/dev/null", path,
  ];
  const diff = spawn("git", args, {
    ...options,
    stdio: [oldObject ? "pipe" : "ignore", "pipe", "ignore"],
  });
  const diffClosed = once(diff, "close");
  const rangesRead = readHunkRanges(diff.stdout);
  try {
    if (!oldObject) {
      return await requireDiffResult(path, diffClosed, rangesRead);
    }

    const blob = spawn("git", ["cat-file", "blob", oldObject], {
      ...options,
      stdio: ["ignore", "pipe", "ignore"],
    });
    diff.stdin.on("error", () => blob.kill());
    blob.stdout.pipe(diff.stdin);
    try {
      const [ranges, [blobCode]] = await Promise.all([
        requireDiffResult(path, diffClosed, rangesRead),
        once(blob, "close"),
      ]);
      if (blobCode !== 0) {
        throw new Error(`delivery scope could not read Git source for ${path}`);
      }
      return ranges;
    } finally {
      blob.kill();
    }
  } finally {
    diff.kill();
  }
}

async function requireDiffResult(path, diffClosed, rangesRead) {
  const [[code], ranges] = await Promise.all([diffClosed, rangesRead]);
  if (code !== 0 && code !== 1) {
    throw new Error(`delivery scope could not capture working source ranges for ${path}`);
  }
  return ranges;
}

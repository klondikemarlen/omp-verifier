import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, TextDecoder } from "node:util";

const run = promisify(execFile);
const decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});
const coordinator = fileURLToPath(new URL("../", import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const GIT_ENV_REDIRECTS = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE",
];

// OMP supplies a new tool-call identity on every invocation of the same command.
const VOLATILE_ENVIRONMENT = new Set([
  "_", "SHLVL", "PWD", "OLDPWD",
  "PI_SESSION_FILE", "PI_SESSION_ID", "PI_TERMINAL_OWNER_PID", "PI_TOOL_CALL_ID",
  "OMP_INSTANCE_CONTROL_LAUNCH_DIR", "OMP_INSTANCE_CONTROL_LAUNCH_TOKEN",
]);
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const MAX_GIT_INVENTORY = 32 * 1024 * 1024;
const INDEX_MODES = new Set(["100644", "100755", "120000"]);
const RAW_CONTENT_ATTRIBUTES = new Set(["filter", "working-tree-encoding", "text", "crlf", "eol", "ident"]);
const BATCH_SIZE = 16;

function add(hash, value) {
  hash.update(JSON.stringify(value)).update("\0");
}

function unavailable() {
  throw new Error("Verification restart identity is unavailable");
}

async function optionalStat(path) {
  try {
    return await lstat(path, {
      bigint: true,
    });
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  }
}

function sameFile(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode &&
    before.size === after.size && before.ctimeNs === after.ctimeNs && before.mtimeNs === after.mtimeNs;
}

async function fileDigest(path, info, budget) {
  if (info.size > BigInt(budget.bytes)) unavailable();

  budget.bytes -= Number(info.size);
  const file = await open(path, READ_FLAGS);
  try {
    const before = await file.stat({
      bigint: true,
    });
    if (!sameFile(info, before)) unavailable();

    const hash = createHash("sha256");
    let remaining = Number(info.size);
    if (remaining <= 128 * 1024) {
      const bytes = Buffer.allocUnsafe(remaining);
      const { bytesRead } = await file.read(bytes);
      if (bytesRead !== remaining) unavailable();

      hash.update(bytes);
      remaining = 0;
    } else {
      const stream = file.createReadStream({
        autoClose: false,
      });
      for await (const bytes of stream) {
        remaining -= bytes.length;
        if (remaining < 0) unavailable();

        hash.update(bytes);
      }
    }
    const after = await file.stat({
      bigint: true,
    });
    if (remaining !== 0 || !sameFile(info, after)) unavailable();

    return hash.digest("hex");
  } finally {
    await file.close();
  }
}

async function describePath(path, info, budget) {
  if (!info) return ["missing"];

  const mode = Number(info.mode);
  if (info.isDirectory()) return ["directory", mode];
  if (info.isFile()) return ["file", mode, await fileDigest(path, info, budget)];
  if (!info.isSymbolicLink()) unavailable();

  const target = await readlink(path, {
    encoding: "buffer",
  });
  const after = await lstat(path, {
    bigint: true,
  });
  if (!sameFile(info, after)) unavailable();

  return ["link", mode, target.toString("base64")];
}

function inside(root, path) {
  const difference = relative(root, path);
  return !isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`);
}

async function git(cwd, args, maxBuffer = MAX_GIT_OUTPUT, input) {
  const command = run("git", [
    "-C", cwd, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args,
  ], {
    encoding: "buffer",
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
    maxBuffer,
    timeout: 10_000,
  });
  let inputError;
  if (input !== undefined) {
    command.child.stdin.on("error", error => {
      inputError = error;
    });
    command.child.stdin.end(input);
  }
  const { stdout } = await command;
  if (inputError) throw inputError;

  return stdout;
}

async function gitLine(cwd, args) {
  const output = decoder.decode(await git(cwd, args));
  if (!output.endsWith("\n")) unavailable();

  return output.slice(0, -1);
}

async function gitCommit(root, ref) {
  const commit = await gitLine(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (!COMMIT.test(commit)) unavailable();

  return commit;
}

function indexPaths(index) {
  const tracked = new Set();
  const readRaw = new Set();
  for (const entry of decoder.decode(index).split("\0")) {
    if (!entry) continue;

    const tab = entry.indexOf("\t");
    const fields = entry.slice(0, tab).split(" ");
    if (tab < 0 || fields.length !== 4 || !INDEX_MODES.has(fields[1])) {
      unavailable();
    }
    const path = entry.slice(tab + 1);
    tracked.add(path);
    // Git may omit hidden index entries from diff-files entirely.
    if (fields[0] !== "H" || fields[1] === "120000" || fields[3] !== "0") readRaw.add(path);
  }
  if (tracked.size > 200_000) unavailable();

  return {
    tracked,
    readRaw,
  };
}

async function hasAutomaticLineEndingConversion(root) {
  try {
    const value = await gitLine(root, ["config", "--type=bool-or-str", "--get", "core.autocrlf"]);
    return value !== "false";
  } catch (error) {
    if (error.code !== 1) throw error;

    return false;
  }
}

async function worktreePaths(root, index, untracked, dirty) {
  const { tracked, readRaw } = indexPaths(index);
  for (const bytes of [untracked, dirty]) {
    for (const path of decoder.decode(bytes).split("\0")) {
      if (path) readRaw.add(path);
    }
  }

  let attributes = Buffer.alloc(0);
  if (tracked.size) {
    const paths = `${[...tracked].join("\0")}\0`;
    const [attributeBytes, normalize] = await Promise.all([
      git(root, ["check-attr", "--all", "-z", "--stdin"], MAX_GIT_INVENTORY, paths),
      hasAutomaticLineEndingConversion(root),
    ]);
    attributes = attributeBytes;
    const fields = decoder.decode(attributes).split("\0");
    if (fields.pop() !== "" || fields.length % 3 !== 0) unavailable();

    // An index blob can differ from the exact worktree bytes after Git filters,
    // even if Git reports that the path is clean.
    for (let index = 0; index < fields.length; index += 3) {
      const attribute = fields[index + 1];
      const value = fields[index + 2];
      if (RAW_CONTENT_ATTRIBUTES.has(attribute) && (value !== "unset" || attribute === "crlf")) {
        readRaw.add(fields[index]);
      }
    }
    if (normalize) {
      for (const path of tracked) readRaw.add(path);
    }
  }
  if (readRaw.size > 25_000) unavailable();

  return {
    paths: [...readRaw].sort(),
    attributes,
  };
}

function realParent(root, path, parents) {
  let pending = parents.get(path);
  if (!pending) {
    pending = realpath(path).then(canonical => {
      if (canonical !== path || !inside(root, canonical)) unavailable();

      return true;
    }).catch(error => {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;

      return false;
    });
    parents.set(path, pending);
  }
  return pending;
}

async function checkoutPath(root, name, parents, budget) {
  if (!name || name.split("/").some(part => !part || part === "." || part === ".." || part === ".git")) {
    unavailable();
  }
  const path = join(root, name);
  if (!await realParent(root, dirname(path), parents)) return [name, ["missing"]];

  return [name, await describePath(path, await optionalStat(path), budget)];
}

async function checkoutIdentity(cwd, base) {
  if (GIT_ENV_REDIRECTS.some(name => Object.hasOwn(process.env, name))) unavailable();

  const root = await realpath(await gitLine(cwd, ["rev-parse", "--show-toplevel"]));
  if (!inside(root, cwd)) unavailable();

  const [gitDirectory, head, branch, index, untracked, dirty, configuration, replacements] = await Promise.all([
    gitLine(cwd, ["rev-parse", "--absolute-git-dir"]),
    gitCommit(root, "HEAD"),
    gitLine(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["ls-files", "--cached", "--stage", "-v", "-z"], MAX_GIT_INVENTORY),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"], MAX_GIT_INVENTORY),
    git(root, [
      "-c", "core.ignoreStat=false", "-c", "core.trustctime=true", "-c", "core.checkStat=default",
      "-c", "core.fileMode=true", "diff-files", "--no-renames", "--no-ext-diff", "--no-textconv", "--name-only", "-z",
    ], MAX_GIT_INVENTORY),
    git(root, ["config", "--null", "--list", "--show-origin"]),
    git(root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/replace"]),
  ]);
  const [rootInfo, gitInfo] = await Promise.all([
    stat(root, {
      bigint: true,
    }),
    stat(gitDirectory, {
      bigint: true,
    }),
  ]);
  const hash = createHash("sha256");
  add(hash, [root, String(rootInfo.dev), String(rootInfo.ino), gitDirectory, String(gitInfo.dev), String(gitInfo.ino), head, branch]);
  for (const bytes of [index, untracked, configuration, replacements]) {
    add(hash, createHash("sha256").update(bytes).digest("hex"));
  }
  if (base !== undefined) {
    if (typeof base !== "string" || !base || base.length > 4_096) unavailable();

    const commit = await gitCommit(root, base);
    const mergeBase = await gitLine(root, ["merge-base", commit, head]);
    if (!COMMIT.test(mergeBase)) unavailable();

    add(hash, [commit, mergeBase]);
  }

  const { paths, attributes } = await worktreePaths(root, index, untracked, dirty);
  add(hash, createHash("sha256").update(attributes).digest("hex"));
  const parents = new Map();
  const budget = {
    bytes: 128 * 1024 * 1024,
  };
  for (let offset = 0; offset < paths.length; offset += BATCH_SIZE) {
    const results = await Promise.all(paths.slice(offset, offset + BATCH_SIZE)
      .map(name => checkoutPath(root, name, parents, budget)));
    for (const result of results) add(hash, result);
  }
  return hash.digest("hex");
}

async function providerPath(hash, path, boundary, budget) {
  if (--budget.entries < 0) unavailable();

  const info = await optionalStat(path);
  add(hash, [path, await describePath(path, info, budget)]);
  if (info?.isSymbolicLink() && !inside(boundary, await realpath(path))) unavailable();
  if (!info?.isDirectory()) return;

  const names = [];
  for await (const entry of await opendir(path)) {
    if (names.length >= budget.entries) unavailable();

    names.push(entry.name);
  }
  for (const name of names.sort()) {
    await providerPath(hash, join(path, name), boundary, budget);
  }
}

async function providerIdentity(command, packageDirectory) {
  const generation = process.env.OMP_VERIFIER_GENERATION;
  if (generation !== undefined) {
    const { id, digest } = JSON.parse(generation);
    const pinnedPackages = process.env.OMP_VERIFIER_PACKAGE_DIRECTORY;
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) ||
        typeof digest !== "string" || !HASH.test(digest) || !pinnedPackages) {
      unavailable();
    }
    const packages = await realpath(packageDirectory);
    if (packages !== await realpath(pinnedPackages)) unavailable();

    return ["generation", id, digest, packages];
  }

  const hash = createHash("sha256");
  const budget = {
    bytes: 64 * 1024 * 1024,
    entries: 12_000,
  };
  const coordinatorRoot = await realpath(coordinator);
  for (const name of ["package.json", "package-lock.json", "bin", "omp-plugin"]) {
    await providerPath(hash, join(coordinatorRoot, name), coordinatorRoot, budget);
  }
  if (command !== "lint") {
    const packages = resolve(packageDirectory);
    const parent = await realpath(dirname(packages));
    const registry = join(parent, "package.json");
    if ((await optionalStat(registry))?.isSymbolicLink()) unavailable();

    await providerPath(hash, registry, parent, budget);
    if (await optionalStat(packages)) {
      const canonical = await realpath(packages);
      add(hash, [packages, canonical]);
      await providerPath(hash, canonical, canonical, budget);
    } else {
      add(hash, [packages, "missing"]);
    }
  }
  return ["direct", hash.digest("hex")];
}

export async function verificationRestartIdentity({ cwd, command, scope, packageDirectory }) {
  const [checkout, provider, node] = await Promise.all([
    checkoutIdentity(cwd, scope?.base),
    providerIdentity(command, packageDirectory),
    stat(process.execPath, {
      bigint: true,
    }),
  ]);
  const environment = Object.keys(process.env).sort()
    .filter(name => !VOLATILE_ENVIRONMENT.has(name))
    .map(name => [name, process.env[name]]);
  const hash = createHash("sha256");
  add(hash, [1, cwd, command, scope, checkout, provider]);
  add(hash, [process.execPath, process.version, process.platform, process.arch, process.execArgv, String(node.ctimeNs)]);
  add(hash, environment);
  return hash.digest("hex");
}

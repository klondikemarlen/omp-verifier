import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DELIVERY_DIRECTORY = resolve(tmpdir(), `omp-verifier-deliveries-${process.getuid?.() ?? "user"}`);
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

async function git(directory, args) {
  // Caller Git environment must not redirect operations into another repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const { stdout } = await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "-C", directory, ...args], {
    env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
    encoding: "buffer",
    maxBuffer: 32_000_000,
  });
  const text = stdout.toString("utf8");
  if (!Buffer.from(text).equals(stdout)) throw new Error("delivery handoff requires UTF-8 Git paths");
  return text;
}

function pinRef(id) {
  return `refs/omp-verifier/deliveries/${id}`;
}

function identity(record) {
  return {
    version: record.version,
    id: record.id,
    originalRoot: record.originalRoot,
    commonDirectory: record.commonDirectory,
    commonDevice: record.commonDevice,
    commonInode: record.commonInode,
    baseCommit: record.baseCommit,
    tipCommit: record.tipCommit,
    changedPaths: record.changedPaths,
  };
}

function identityMessage(record) {
  const digest = createHash("sha256").update(JSON.stringify(identity(record))).digest("hex");
  return `omp-verifier delivery identity ${digest}`;
}

function result(record, handoffPath) {
  return {
    ...identity(record),
    status: record.status,
    handoffPath,
    checkoutPath: join(dirname(handoffPath), "checkout"),
    ...(record.cancellationReason ? { cancellationReason: record.cancellationReason } : {}),
  };
}

async function privateEntry(path, directory) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()) ||
      (!directory && info.nlink !== 1)) {
    throw new Error(`delivery handoff path is not privately owned: ${path}`);
  }
  if (await realpath(path) !== resolve(path)) throw new Error(`delivery handoff path is not canonical: ${path}`);
}

async function storageDirectory() {
  await mkdir(DELIVERY_DIRECTORY, { mode: 0o700 });
}

async function ensureStorageDirectory() {
  try {
    await storageDirectory();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await privateEntry(DELIVERY_DIRECTORY, true);
}

async function commonDirectory(root) {
  return realpath((await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
}

async function commit(directory, reference) {
  if (typeof reference !== "string" || !reference.trim()) throw new Error("delivery handoff requires a base reference");
  const oid = (await git(directory, ["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`])).trim();
  if (!COMMIT_PATTERN.test(oid)) throw new Error("delivery handoff has an invalid commit identity");
  return oid;
}

async function changedPaths(directory, baseCommit, tipCommit) {
  await git(directory, ["merge-base", "--is-ancestor", baseCommit, tipCommit]);
  const output = await git(directory, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none", "--name-only", "-z", baseCommit, tipCommit, "--"]);
  return output ? output.slice(0, -1).split("\0") : [];
}

async function requireClean(directory, { includeIgnored = false } = {}) {
  const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"];
  if (includeIgnored) args.push("--ignored");
  if (await git(directory, args)) throw new Error(`delivery handoff refuses dirty or untracked source: ${directory}`);
}

function validateRecord(record, id) {
  const validPath = value => typeof value === "string" && isAbsolute(value) && resolve(value) === value;
  const validChangedPath = value => typeof value === "string" && value.length > 0 && !value.includes("\0") &&
    !isAbsolute(value) && !value.split("/").some(part => part === ".." || part === "." || part === "");
  if (!record || record.version !== 1 || record.id !== id ||
      !validPath(record.originalRoot) || !validPath(record.commonDirectory) ||
      typeof record.commonDevice !== "string" || !/^\d+$/.test(record.commonDevice) ||
      typeof record.commonInode !== "string" || !/^\d+$/.test(record.commonInode) ||
      typeof record.baseCommit !== "string" || !COMMIT_PATTERN.test(record.baseCommit) ||
      typeof record.tipCommit !== "string" || !COMMIT_PATTERN.test(record.tipCommit) ||
      !Array.isArray(record.changedPaths) || !record.changedPaths.every(validChangedPath) ||
      new Set(record.changedPaths).size !== record.changedPaths.length ||
      !["PREPARED", "RECOVERED", "RELEASING", "RELEASED", "CANCELLED"].includes(record.status) ||
      (record.status === "CANCELLED" && (typeof record.cancellationReason !== "string" || !record.cancellationReason.trim())) ||
      (record.status === "RELEASING" && !["RELEASED", "CANCELLED"].includes(record.releaseStatus)) ||
      (record.releaseStatus === "CANCELLED" && (typeof record.cancellationReason !== "string" || !record.cancellationReason.trim()))) {
    throw new Error("delivery handoff record has an invalid shape or identity");
  }
}

async function withHandoff(handoffPath, operation) {
  if (typeof handoffPath !== "string" || !isAbsolute(handoffPath) || resolve(handoffPath) !== handoffPath ||
      basename(handoffPath) !== "handoff.json" || dirname(dirname(handoffPath)) !== DELIVERY_DIRECTORY ||
      !ID_PATTERN.test(basename(dirname(handoffPath)))) {
    throw new Error("delivery handoff must identify its canonical private handoff.json");
  }
  await privateEntry(DELIVERY_DIRECTORY, true);
  await privateEntry(dirname(handoffPath), true);
  await privateEntry(handoffPath, false);
  const lockPath = join(dirname(handoffPath), "operation.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("delivery handoff operation is busy; preserve its resources until the owner finishes", { cause: error });
    throw error;
  }
  try {
    const record = JSON.parse(await readFile(handoffPath, "utf8"));
    validateRecord(record, basename(dirname(handoffPath)));
    return await operation(record);
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}

async function writeRecord(handoffPath, record) {
  const temporaryPath = join(dirname(handoffPath), `${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporaryPath, handoffPath);
}

async function validateRepository(record) {
  if (await realpath(record.commonDirectory) !== record.commonDirectory) throw new Error("delivery repository location changed");
  const info = await stat(record.commonDirectory, { bigint: true });
  if (!info.isDirectory() || String(info.dev) !== record.commonDevice || String(info.ino) !== record.commonInode) {
    throw new Error("delivery repository identity changed");
  }
  if (await commonDirectory(record.commonDirectory) !== record.commonDirectory) throw new Error("delivery Git database identity changed");
  const references = await git(record.commonDirectory, ["for-each-ref", "--format=%(refname) %(objectname)", pinRef(record.id)]);
  const expected = `${pinRef(record.id)} ${record.tipCommit}\n`;
  if (references !== expected) throw new Error("delivery source pin is missing or changed");
  const message = (await git(record.commonDirectory, ["reflog", "show", "-1", "--format=%gs", pinRef(record.id)])).trim();
  if (message !== identityMessage(record)) throw new Error("delivery handoff identity was changed");
  if (await commit(record.commonDirectory, record.tipCommit) !== record.tipCommit ||
      await commit(record.commonDirectory, record.baseCommit) !== record.baseCommit ||
      JSON.stringify(await changedPaths(record.commonDirectory, record.baseCommit, record.tipCommit)) !== JSON.stringify(record.changedPaths)) {
    throw new Error("delivery source commits or complete path scope changed");
  }
}

async function checkoutExists(checkoutPath) {
  try {
    await lstat(checkoutPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function validateCheckout(record, checkoutPath, { includeIgnored = false } = {}) {
  const info = await lstat(checkoutPath);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(checkoutPath) !== checkoutPath) {
    throw new Error("delivery checkout is not its owned canonical directory");
  }
  const root = await realpath((await git(checkoutPath, ["rev-parse", "--show-toplevel"])).trim());
  const gitDirectory = await realpath((await git(checkoutPath, ["rev-parse", "--absolute-git-dir"])).trim());
  const pointer = (await readFile(join(gitDirectory, "gitdir"), "utf8")).trim();
  if (root !== checkoutPath || await commonDirectory(checkoutPath) !== record.commonDirectory ||
      dirname(gitDirectory) !== join(record.commonDirectory, "worktrees") || pointer !== join(checkoutPath, ".git") ||
      (await git(checkoutPath, ["rev-parse", "HEAD"])).trim() !== record.tipCommit ||
      (await readFile(join(gitDirectory, "HEAD"), "utf8")).trim() !== record.tipCommit) {
    throw new Error("delivery checkout is foreign, attached, or has a changed source identity");
  }
  await requireClean(checkoutPath, { includeIgnored });
}

export async function prepareDeliveryHandoff({ cwd, baseRef }) {
  const originalRoot = await realpath(cwd);
  const gitRoot = await realpath((await git(originalRoot, ["rev-parse", "--show-toplevel"])).trim());
  if (gitRoot !== originalRoot) throw new Error("prepare delivery handoff from the Git source root");
  await requireClean(originalRoot);
  const tipCommit = await commit(originalRoot, "HEAD");
  const baseCommit = await commit(originalRoot, baseRef);
  const paths = await changedPaths(originalRoot, baseCommit, tipCommit);
  const common = await commonDirectory(originalRoot);
  const info = await stat(common, { bigint: true });
  const record = {
    version: 1,
    id: randomUUID(),
    originalRoot,
    commonDirectory: common,
    commonDevice: String(info.dev),
    commonInode: String(info.ino),
    baseCommit,
    tipCommit,
    changedPaths: paths,
    status: "PREPARED",
  };
  await ensureStorageDirectory();
  const directory = join(DELIVERY_DIRECTORY, record.id);
  await mkdir(directory, { mode: 0o700 });
  const handoffPath = join(directory, "handoff.json");
  await writeFile(handoffPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await git(common, ["update-ref", "--create-reflog", "-m", identityMessage(record), pinRef(record.id), tipCommit, "0".repeat(tipCommit.length)]);
  // Do not hand off a moving or newly dirty source tree.
  await requireClean(originalRoot);
  if (await commit(originalRoot, "HEAD") !== tipCommit) throw new Error(`delivery source moved during preparation; preserve ${handoffPath}`);
  return result(record, handoffPath);
}

export async function recoverDeliveryHandoff({ handoffPath }) {
  return withHandoff(handoffPath, async record => {
    if (!["PREPARED", "RECOVERED"].includes(record.status)) throw new Error(`cannot recover a ${record.status.toLowerCase()} delivery handoff`);
    await validateRepository(record);
    const checkoutPath = join(dirname(handoffPath), "checkout");
    if (!await checkoutExists(checkoutPath)) {
      await git(record.commonDirectory, ["worktree", "add", "--detach", checkoutPath, record.tipCommit]);
    }
    await validateCheckout(record, checkoutPath);
    record.status = "RECOVERED";
    await writeRecord(handoffPath, record);
    return result(record, handoffPath);
  });
}

export async function releaseDeliveryHandoff({ handoffPath, cancellationReason }) {
  if (cancellationReason !== undefined && (typeof cancellationReason !== "string" || !cancellationReason.trim())) {
    throw new Error("delivery cancellation requires a nonempty explicit reason");
  }
  const status = cancellationReason === undefined ? "RELEASED" : "CANCELLED";
  return withHandoff(handoffPath, async record => {
    if (["RELEASED", "CANCELLED"].includes(record.status)) {
      if (record.status !== status || (status === "CANCELLED" && record.cancellationReason !== cancellationReason)) {
        throw new Error("delivery handoff already has a different final disposition");
      }
      return result(record, handoffPath);
    }
    if (record.status === "RELEASING" && (record.releaseStatus !== status || record.cancellationReason !== cancellationReason)) {
      throw new Error("delivery release is already in progress with a different disposition");
    }
    await validateRepository(record);
    const checkoutPath = join(dirname(handoffPath), "checkout");
    if (await checkoutExists(checkoutPath)) {
      await validateCheckout(record, checkoutPath, { includeIgnored: true });
    }
    // An interrupted disposal stays nonrecoverable; retries still require its intact source pin.
    record.status = "RELEASING";
    record.releaseStatus = status;
    if (cancellationReason !== undefined) record.cancellationReason = cancellationReason;
    await writeRecord(handoffPath, record);
    if (await checkoutExists(checkoutPath)) await git(record.commonDirectory, ["worktree", "remove", checkoutPath]);
    await git(record.commonDirectory, ["update-ref", "-d", pinRef(record.id), record.tipCommit]);
    record.status = status;
    delete record.releaseStatus;
    await writeRecord(handoffPath, record);
    return result(record, handoffPath);
  });
}

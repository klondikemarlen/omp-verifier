import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MAX_WORKSPACE_RUNS = 50;
const MAX_RUNS = 500;
const MAX_ASSESSMENTS = 500;
const TIMESTAMP_WIDTH = 16;
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const UUID_PATTERN = new RegExp(`^${UUID}$`);
const RUN_NAME = new RegExp(`^\\d{${TIMESTAMP_WIDTH}}-${UUID}-([0-9a-f]{64})\\.json$`);
const ASSESSMENT_NAME = new RegExp(`^\\d{${TIMESTAMP_WIDTH}}-(${UUID})\\.json$`);
const COMMANDS = new Set(["verify", "automatic", "handoff check", "lint"]);
const TERMINAL_STATUSES = new Set(["PASS", "FAIL", "BLOCKED"]);
const CHECK_STATUSES = new Set([...TERMINAL_STATUSES, "STARTED", "PENDING", "SUPPRESSED", "N/A"]);
const CHECK_ID = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isDuration(value) {
  return value === null || (Number.isFinite(value) && value >= 0);
}

function projectCheck({ id, status, durationMs, requestId, startedAt, timeoutMs, timedOut }) {
  if (!CHECK_STATUSES.has(status) || !isDuration(durationMs)) {
    throw new Error("Invalid verifier timing check");
  }
  if (startedAt !== undefined && !isTimestamp(startedAt)) {
    throw new Error("Invalid verifier check start");
  }
  if (status === "STARTED" && (startedAt === undefined || durationMs !== null)) {
    throw new Error("A verifier check start cannot include a completed duration");
  }
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || startedAt === undefined)) {
    throw new Error("Invalid verifier check timeout budget");
  }
  const canReportTimeout = (status === "BLOCKED" || status === "FAIL") && timeoutMs !== undefined && durationMs !== null;
  if (timedOut !== undefined && (timedOut !== true || !canReportTimeout)) {
    throw new Error("Invalid verifier check timeout observation");
  }

  let checkId = "unidentified";
  if (typeof id === "string" && id.length <= 200 && CHECK_ID.test(id)) {
    checkId = id;
  }

  const check = {
    id: checkId,
    status,
    durationMs,
  };
  if (startedAt !== undefined) {
    check.startedAt = startedAt;
  }
  if (timeoutMs !== undefined) {
    check.timeoutMs = timeoutMs;
  }
  if (timedOut === true) {
    check.timedOut = true;
  }
  if (status === "PENDING" && isUuid(requestId)) {
    check.requestId = requestId;
  }
  return check;
}

function projectRun({
  id,
  command,
  startedAt,
  coordinatorMs,
  checks,
  generation,
  cancelledAfterMs,
  cancellationSignal,
}) {
  if (!isUuid(id) || !COMMANDS.has(command) || !isTimestamp(startedAt) || !isDuration(coordinatorMs)
    || !Array.isArray(checks) || (generation !== null && !isUuid(generation))) {
    throw new Error("Invalid verifier timing run");
  }

  const hasCancellation = cancelledAfterMs !== undefined || cancellationSignal !== undefined;
  if (hasCancellation && (coordinatorMs !== null
    || !Number.isSafeInteger(cancelledAfterMs) || cancelledAfterMs < 0
    || (cancellationSignal !== "SIGINT" && cancellationSignal !== "SIGTERM"))) {
    throw new Error("Invalid verifier timing cancellation");
  }

  const projectedChecks = checks.map(projectCheck);
  if (coordinatorMs !== null && projectedChecks.some(check => check.status === "STARTED")) {
    throw new Error("A completed verification run cannot contain an unfinished check");
  }
  const run = {
    id,
    command,
    startedAt,
    coordinatorMs,
    checks: projectedChecks,
    generation,
  };
  if (hasCancellation) {
    run.cancelledAfterMs = cancelledAfterMs;
    run.cancellationSignal = cancellationSignal;
  }
  return run;
}

function projectAssessment({ requestId, status, completedAt }) {
  if (!isUuid(requestId) || !TERMINAL_STATUSES.has(status) || !isTimestamp(completedAt)) {
    throw new Error("Invalid verifier timing assessment");
  }

  return {
    requestId,
    status,
    completedAt,
  };
}

async function workspaceKey(cwd) {
  const canonicalCwd = await realpath(cwd);
  return createHash("sha256").update(canonicalCwd).digest("hex");
}

function isOwned(info) {
  return !process.getuid || info.uid === process.getuid();
}

async function assertDirectory(path, unsafeMode) {
  const info = await lstat(path);
  if (!info.isDirectory() || !isOwned(info) || (info.mode & unsafeMode) !== 0) {
    throw new Error("Verifier timing directory is not privately controlled");
  }
}

// A project-local agent install must not add the observer's files to Git's
// changed-path selection, including when the command runs in a subdirectory.
async function requireExternalStorage(directory) {
  let ancestor = directory;
  for (;;) {
    try {
      ancestor = await realpath(ancestor);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  for (;;) {
    try {
      await lstat(join(ancestor, ".git"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) return;
      ancestor = parent;
      continue;
    }
    throw new Error("Timing storage must be outside a Git checkout");
  }
}

async function historyDirectory(section, { create = false } = {}) {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
  const verifierDirectory = resolve(agentDirectory, "verifier");
  const timingDirectory = join(verifierDirectory, "timings");
  const directory = join(timingDirectory, section);
  if (create) {
    await requireExternalStorage(verifierDirectory);
    await mkdir(verifierDirectory, {
      mode: 0o700,
      recursive: true,
    });
  }
  // The existing verifier directory may be readable by others, but cannot be a link or writable by them.
  await assertDirectory(verifierDirectory, 0o022);
  for (const path of [timingDirectory, directory]) {
    if (create) {
      await mkdir(path, {
        mode: 0o700,
        recursive: true,
      });
    }
    await assertDirectory(path, 0o077);
  }
  return directory;
}

function recordName(timestamp, id, key) {
  const stem = `${String(timestamp).padStart(TIMESTAMP_WIDTH, "0")}-${id}`;
  if (key) {
    return `${stem}-${key}.json`;
  }
  return `${stem}.json`;
}

async function recordNames(directory, pattern, { filesOnly = false } = {}) {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  const names = entries
    .filter(entry => pattern.test(entry.name) && (!filesOnly || entry.isFile()))
    .map(entry => entry.name);
  return names.sort().reverse();
}

async function unlinkIfPresent(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function writeRecord(directory, name, record) {
  const destination = join(directory, name);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(record));
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
  } finally {
    await unlinkIfPresent(temporary);
  }
}

async function pruneRuns(directory) {
  const names = await recordNames(directory, RUN_NAME, {
    filesOnly: true,
  });
  const retainedByWorkspace = new Map();
  let retained = 0;
  // Apply each workspace cap before counting toward the global cap. The sort
  // key is immutable, so a finish cannot promote an old snapshot during pruning.
  for (const name of names) {
    const [, key] = RUN_NAME.exec(name);
    const workspaceCount = retainedByWorkspace.get(key) ?? 0;
    if (workspaceCount < MAX_WORKSPACE_RUNS && retained < MAX_RUNS) {
      retainedByWorkspace.set(key, workspaceCount + 1);
      retained += 1;
      continue;
    }
    await unlinkIfPresent(join(directory, name));
  }
}

async function readRecord(directory, name, project) {
  let handle;
  try {
    handle = await open(join(directory, name), READ_FLAGS);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  try {
    const info = await handle.stat();
    if (!info.isFile() || !isOwned(info) || (info.mode & 0o077) !== 0) {
      throw new Error("Verifier timing record is not privately owned");
    }
    const contents = await handle.readFile("utf8");
    let record;
    try {
      record = JSON.parse(contents);
    } catch {
      throw new Error("Invalid verifier timing record JSON");
    }
    return project(record);
  } finally {
    await handle.close();
  }
}

async function existingHistory(section, pattern) {
  try {
    const directory = await historyDirectory(section);
    const names = await recordNames(directory, pattern);
    return {
      directory,
      names,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readAssessments(requestIds) {
  const assessments = new Map();
  if (requestIds.size === 0) {
    return assessments;
  }

  const history = await existingHistory("assessments", ASSESSMENT_NAME);
  if (!history) {
    return assessments;
  }

  const { directory, names } = history;
  for (const name of names) {
    const [, requestId] = ASSESSMENT_NAME.exec(name);
    if (!requestIds.has(requestId) || assessments.has(requestId)) {
      continue;
    }

    const marker = await readRecord(directory, name, projectAssessment);
    if (!marker) {
      continue;
    }
    if (name !== recordName(marker.completedAt, marker.requestId)) {
      throw new Error("Verifier timing assessment does not match its record name");
    }
    assessments.set(requestId, marker);
  }
  return assessments;
}

function addCompletion(run, assessments) {
  let elapsedMs = run.coordinatorMs ?? 0;
  let isComplete = run.coordinatorMs !== null;
  for (const check of run.checks) {
    if (check.status !== "PENDING") {
      continue;
    }

    const marker = assessments.get(check.requestId);
    if (!marker || marker.completedAt < run.startedAt) {
      isComplete = false;
      continue;
    }
    check.finalStatus = marker.status;
    check.elapsedMs = marker.completedAt - run.startedAt;
    elapsedMs = Math.max(elapsedMs, check.elapsedMs);
  }
  run.fullRunMs = isComplete ? elapsedMs : null;
  return run;
}

export async function saveTimingRun(cwd, record) {
  const run = projectRun(record);
  const key = await workspaceKey(cwd);
  const directory = await historyDirectory("runs", {
    create: true,
  });
  const name = recordName(run.startedAt, run.id, key);
  await writeRecord(directory, name, run);
  await pruneRuns(directory);
}

export async function saveTimingAssessment(assessment) {
  const marker = projectAssessment(assessment);
  const directory = await historyDirectory("assessments", {
    create: true,
  });
  const name = recordName(marker.completedAt, marker.requestId);
  await writeRecord(directory, name, marker);
  const names = await recordNames(directory, ASSESSMENT_NAME, {
    filesOnly: true,
  });
  for (const obsolete of names.slice(MAX_ASSESSMENTS)) {
    await unlinkIfPresent(join(directory, obsolete));
  }
}

export async function readTimingHistory(cwd, limit = 10) {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("Verifier timing history limit must be a nonnegative integer");
  }
  if (limit === 0) {
    return [];
  }

  let key;
  try {
    key = await workspaceKey(cwd);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const history = await existingHistory("runs", RUN_NAME);
  if (!history) {
    return [];
  }

  const { directory, names } = history;
  const workspaceSuffix = `-${key}.json`;
  const maxResults = Math.min(limit, MAX_WORKSPACE_RUNS);
  const runs = [];
  const requestIds = new Set();
  for (const name of names) {
    if (runs.length >= maxResults) {
      break;
    }
    if (!name.endsWith(workspaceSuffix)) {
      continue;
    }

    const run = await readRecord(directory, name, projectRun);
    if (!run) {
      continue;
    }
    if (name !== recordName(run.startedAt, run.id, key)) {
      throw new Error("Verifier timing run does not match its record name");
    }
    runs.push(run);
    for (const check of run.checks) {
      if (check.requestId) {
        requestIds.add(check.requestId);
      }
    }
  }

  const assessments = await readAssessments(requestIds);
  return runs.map(run => addCompletion(run, assessments));
}

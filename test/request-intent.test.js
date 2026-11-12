import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import verifierPlugin from "#root/omp-plugin/index.js";
import { createRequestIntent, readRequestIntent } from "#root/omp-plugin/request-intent.js";

async function requestFixture(t, prompt, sessionId = randomUUID()) {
  const intent = await createRequestIntent({ sessionId, prompt });
  t.after(() => rm(dirname(intent.path), { recursive: true, force: true }));
  return { intent, sessionId };
}

async function pluginFixture(t) {
  const agentDir = await mkdtemp(join(tmpdir(), "omp-verifier-intent-plugin-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const events = new Map();
  await verifierPlugin({
    setLabel() {},
    pi: { getAgentDir: () => agentDir },
    on: (event, handler) => events.set(event, handler),
    registerCommand() {},
  });
  return { hook: events.get("before_agent_start") };
}

const prefixCases = [
  ["Verifier work level: quick tweak\nRename this variable.", "quick-tweak"],
  ["Verifier work level: normal\nRepair this bug.", "normal"],
  ["Verifier work level: rearchitecture\nChange these boundaries.", "rearchitecture"],
  ["Verifier work level: quick tweak\r\nRename this variable.", "quick-tweak"],
  ["Just a quick tweak, please.", "normal"],
  ["\nVerifier work level: quick tweak", "normal"],
  ["Instructions\nVerifier work level: quick tweak", "normal"],
  [" Verifier work level: quick tweak", "normal"],
  ["verifier work level: quick tweak", "normal"],
];
for (const [prompt, expected] of prefixCases) {
  test(`when the prompt is ${JSON.stringify(prompt)}, exact first-line parsing selects ${expected}`, async t => {
    // Arrange
    const { intent } = await requestFixture(t, prompt);

    // Act
    const restored = await readRequestIntent(intent.handle);

    // Assert
    assert.equal(restored.level, expected);
    assert.equal(restored.requestId, intent.requestId);
    assert.equal(restored.handle, intent.handle);
    assert.match(restored.handle, /^[0-9a-f]{32}\.[0-9a-f-]{36}$/);
  });
}

for (const declaration of ["Verifier work level: tiny", "Verifier work level: quick tweak ", "Verifier work level:quick tweak"]) {
  test(`when an explicit prefix is unknown (${declaration}), normal retains a diagnostic without exemption`, async t => {
    // Arrange
    const { intent } = await requestFixture(t, declaration);

    // Act
    const restored = await readRequestIntent(intent.handle);

    // Assert
    assert.equal(restored.level, "normal");
    assert.match(restored.diagnostic, /Unknown explicit.*no exemption/);
  });
}

test("when a queued batch contains multiple declarations, normal replaces the ambiguous selection", async t => {
  // Arrange
  const { intent } = await requestFixture(t, "Verifier work level: quick tweak\nFirst task.\n\nVerifier work level: rearchitecture\nSecond task.");

  // Act
  const restored = await readRequestIntent(intent.handle);

  // Assert
  assert.equal(restored.level, "normal");
  assert.match(restored.diagnostic, /Multiple.*ambiguous/);
});

test("when another actual prompt arrives, the prior instance expires and storage remains bounded", async t => {
  // Arrange
  const { intent: first, sessionId } = await requestFixture(t, "Verifier work level: quick tweak");

  // Act
  const second = await createRequestIntent({ sessionId, prompt: "Make another change." });
  const files = await readdir(dirname(second.path));

  // Assert
  assert.equal(second.level, "normal");
  assert.notEqual(second.requestId, first.requestId);
  assert.deepEqual(files.sort(), ["current.json", `${second.requestId}.json`].sort());
  await assert.rejects(readRequestIntent(first.handle), /ENOENT|superseded/);
  assert.deepEqual(await readRequestIntent(second.handle), second);
});

test("when identical text is submitted again, it still creates a fresh request instance", async t => {
  // Arrange
  const prompt = "Verifier work level: quick tweak\nSame change.";
  const { intent: first, sessionId } = await requestFixture(t, prompt);

  // Act
  const second = await createRequestIntent({ sessionId, prompt });

  // Assert
  assert.notEqual(first.handle, second.handle);
  assert.notEqual(first.requestId, second.requestId);
  await assert.rejects(readRequestIntent(first.handle));
  assert.equal((await readRequestIntent(second.handle)).level, "quick-tweak");
});

test("when another session receives a prompt, its intent cannot supersede this session", async t => {
  // Arrange
  const { intent: first } = await requestFixture(t, "Verifier work level: quick tweak");

  // Act
  const { intent: other } = await requestFixture(t, "Verifier work level: rearchitecture");

  // Assert
  assert.equal((await readRequestIntent(first.handle)).level, "quick-tweak");
  assert.equal((await readRequestIntent(other.handle)).level, "rearchitecture");
  await assert.rejects(readRequestIntent(`${first.handle.split(".")[0]}.${other.requestId}`));
});

test("when request intent is stored, files are private and contain a prompt hash but no raw prompt", async t => {
  // Arrange
  const prompt = "Verifier work level: quick tweak\nPRIVATE request body never stored.";
  const { intent } = await requestFixture(t, prompt);

  // Act
  const recordText = await readFile(intent.path, "utf8");
  const currentText = await readFile(join(dirname(intent.path), "current.json"), "utf8");
  const record = JSON.parse(recordText);

  // Assert
  assert.match(record.promptHash, /^[0-9a-f]{64}$/);
  assert.equal(recordText.includes("PRIVATE"), false);
  assert.equal(currentText.includes("PRIVATE"), false);
  assert.equal((await stat(dirname(intent.path))).mode & 0o077, 0);
  assert.equal((await stat(intent.path)).mode & 0o777, 0o400);
  assert.equal((await stat(join(dirname(intent.path), "current.json"))).mode & 0o077, 0);
});

test("when a request record changes, the current-record digest rejects it", async t => {
  // Arrange
  const { intent } = await requestFixture(t, "Normal request.");
  const record = JSON.parse(await readFile(intent.path, "utf8"));

  // Act
  await chmod(intent.path, 0o600);
  await writeFile(intent.path, JSON.stringify({ ...record, level: "quick-tweak" }));

  // Assert
  await assert.rejects(readRequestIntent(intent.handle), /changed, invalid, or superseded/);
});

test("when an arbitrary path or symlink is supplied, no request exemption is accepted", async t => {
  // Arrange
  const { intent } = await requestFixture(t, "Verifier work level: quick tweak");
  const target = join(dirname(intent.path), "outside.json");

  // Act
  await writeFile(target, await readFile(intent.path), { mode: 0o600 });
  await rm(intent.path);
  await symlink(target, intent.path);

  // Assert
  await assert.rejects(readRequestIntent(target), /invalid request intent handle/);
  await assert.rejects(readRequestIntent(intent.path), /invalid request intent handle/);
  await assert.rejects(readRequestIntent(intent.handle), /privately owned/);
  await assert.rejects(readRequestIntent("../outside.json"), /invalid request intent handle/);
});

test("when session identity is missing, direct creation refuses an unbound intent", async () => {
  // Arrange
  const prompt = "Verifier work level: quick tweak";

  // Act
  const missingIdentity = createRequestIntent({ prompt });
  const emptyIdentity = createRequestIntent({ sessionId: "", prompt });

  // Assert
  await assert.rejects(missingIdentity, /session identity/);
  await assert.rejects(emptyIdentity, /session identity/);
});

test("when the supported prompt hook fires, visible context starts with the complete handle and level", async t => {
  // Arrange
  const { hook } = await pluginFixture(t);
  const sessionId = randomUUID();
  const ctx = { sessionManager: { getSessionId: () => sessionId } };

  // Act
  const result = await hook({ reason: "prompt", prompt: "Verifier work level: quick tweak\nRename.", systemPrompt: ["Existing policy."] }, ctx);
  const handle = result.message.content.match(/--request ([0-9a-f.-]+)/)[1];
  const intent = await readRequestIntent(handle);
  t.after(() => rm(dirname(intent.path), { recursive: true, force: true }));

  // Assert
  assert.equal(result.message.customType, "verifier-work-intent");
  assert.equal(result.message.display, true);
  assert.equal(result.message.attribution, "agent");
  assert.equal(intent.level, "quick-tweak");
  assert.ok(result.message.content.slice(0, 120).includes(`quick-tweak --request ${handle}`));
  assert.match(result.message.content, /automatic --request/);
  assert.match(result.message.content, /--full/);
  assert.match(result.message.content, /not PASS.*mandatory.*explicit verification.*initial delivery\/release.*semantic escalation/);
  assert.equal(result.systemPrompt[0], "Existing policy.");
  assert.match(result.systemPrompt[1], /Verifier delivery cleanup:.*handoff prepare/);
});

test("when revive fires for the same proven instance, it preserves rather than recreates request intent", async t => {
  // Arrange
  const { hook } = await pluginFixture(t);
  const sessionId = randomUUID();
  const ctx = { sessionManager: { getSessionId: () => sessionId } };
  const initial = await hook({ reason: "prompt", prompt: "Verifier work level: rearchitecture", systemPrompt: [] }, ctx);
  const handle = initial.message.content.match(/--request ([0-9a-f.-]+)/)[1];
  const intent = await readRequestIntent(handle);
  t.after(() => rm(dirname(intent.path), { recursive: true, force: true }));

  // Act
  const revived = await hook({ reason: "revive", prompt: "", systemPrompt: [] }, ctx);

  // Assert
  assert.equal(revived.message.content, initial.message.content);
  assert.deepEqual(await readRequestIntent(handle), intent);
});

test("when revive has no matching session instance, it defaults normal without replacing the actual request", async t => {
  // Arrange
  const { hook } = await pluginFixture(t);
  const sessionId = randomUUID();
  const ctx = { sessionManager: { getSessionId: () => sessionId } };
  const initial = await hook({ reason: "prompt", prompt: "Verifier work level: quick tweak", systemPrompt: [] }, ctx);
  const handle = initial.message.content.match(/--request ([0-9a-f.-]+)/)[1];
  const intent = await readRequestIntent(handle);
  t.after(() => rm(dirname(intent.path), { recursive: true, force: true }));

  // Act
  const revived = await hook({ reason: "revive", prompt: "Verifier work level: rearchitecture", systemPrompt: [] }, { sessionManager: { getSessionId: () => randomUUID() } });

  // Assert
  assert.match(revived.message.content, /normal; no request handle/);
  assert.equal(revived.message.content.includes("--request"), false);
  assert.equal((await readRequestIntent(handle)).requestId, intent.requestId);
});

test("when a subsequent prompt lacks a prefix, hook state resets rather than reusing quick tweak", async t => {
  // Arrange
  const { hook } = await pluginFixture(t);
  const sessionId = randomUUID();
  const ctx = { sessionManager: { getSessionId: () => sessionId } };
  const initial = await hook({ reason: "prompt", prompt: "Verifier work level: quick tweak", systemPrompt: [] }, ctx);
  const firstHandle = initial.message.content.match(/--request ([0-9a-f.-]+)/)[1];

  // Act
  const next = await hook({ reason: "prompt", prompt: "Another task.", systemPrompt: [] }, ctx);
  const nextHandle = next.message.content.match(/--request ([0-9a-f.-]+)/)[1];
  const nextIntent = await readRequestIntent(nextHandle);
  t.after(() => rm(dirname(nextIntent.path), { recursive: true, force: true }));

  // Assert
  assert.equal(nextIntent.level, "normal");
  assert.notEqual(nextHandle, firstHandle);
  await assert.rejects(readRequestIntent(firstHandle));
});

test("when supported identity or reason is absent, the hook provides normal without guessing from metadata", async t => {
  // Arrange
  const { hook } = await pluginFixture(t);
  const event = { reason: "prompt", prompt: "Verifier work level: quick tweak", systemPrompt: [] };

  // Act
  const missingIdentity = await hook(event, { model: { sessionId: "not-host-identity" } });
  const missingReason = await hook({ ...event, reason: undefined }, { sessionManager: { getSessionId: () => randomUUID() } });
  const coldRevive = await hook({ ...event, reason: "revive" }, { sessionManager: { getSessionId: () => randomUUID() } });

  // Assert
  assert.match(missingIdentity.message.content, /normal; no request handle/);
  assert.match(missingReason.message.content, /normal; no request handle/);
  assert.match(coldRevive.message.content, /normal; no request handle/);
  assert.equal(missingIdentity.message.content.includes("--request"), false);
});

test("when the persisted current pointer changes, a formerly valid handle is rejected", async t => {
  // Arrange
  const { intent } = await requestFixture(t, "Verifier work level: quick tweak");
  const currentPath = join(dirname(intent.path), "current.json");
  const current = JSON.parse(await readFile(currentPath, "utf8"));

  // Act
  await writeFile(currentPath, JSON.stringify({ ...current, requestId: randomUUID() }));

  // Assert
  await assert.rejects(readRequestIntent(intent.handle), /changed, invalid, or superseded/);
});

test("when a newer actual request supersedes the remembered one, revive cannot restore stale quick intent", async t => {
  // Arrange
  const { hook } = await pluginFixture(t);
  const sessionId = randomUUID();
  const ctx = { sessionManager: { getSessionId: () => sessionId } };
  await hook({ reason: "prompt", prompt: "Verifier work level: quick tweak", systemPrompt: [] }, ctx);
  const { intent: newer } = await requestFixture(t, "A newer actual request.", sessionId);

  // Act
  const revived = await hook({ reason: "revive", prompt: "", systemPrompt: [] }, ctx);

  // Assert
  assert.match(revived.message.content, /normal; no request handle/);
  assert.match(revived.message.content, /Request intent unavailable/);
  assert.equal(revived.message.content.includes("--request"), false);
  assert.equal((await readRequestIntent(newer.handle)).level, "normal");
});

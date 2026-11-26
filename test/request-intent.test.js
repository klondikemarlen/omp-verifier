import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import verifierPlugin from "#root/omp-plugin/index.js";
import { createRequestIntent, openRequestWaiverAuthority, readRequestIntent } from "#root/omp-plugin/request-intent.js";

async function requestFixture(t, prompt, sessionId = randomUUID()) {
  const intent = await createRequestIntent({ sessionId, prompt });
  t.after(() => rm(dirname(intent.path), { recursive: true, force: true }));
  return { intent, sessionId };
}

async function pluginFixture(t) {
  const agentDir = await mkdtemp(join(tmpdir(), "omp-verifier-intent-plugin-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const events = new Map();
  const commands = new Map();
  const renderers = new Map();
  const tools = new Map();
  const schema = {
    min: () => schema,
    max: () => schema,
    describe: () => schema,
    strict: () => schema,
  };
  await verifierPlugin({
    setLabel() {},
    pi: { getAgentDir: () => agentDir },
    on: (event, handler) => events.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: tool => tools.set(tool.name, tool),
    zod: {
      string: () => schema,
      array: () => schema,
      object: () => schema,
    },
    registerMessageRenderer: (type, renderer) => renderers.set(type, renderer),
  });
  t.after(() => events.get("session_shutdown")());
  return {
    hook: events.get("before_agent_start"),
    command: commands.get("verifier").handler,
    events,
    renderers,
    tools,
  };
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

test("when the prompt hook supplies request intent, the chat stays quiet without removing advisor context", async t => {
  // Arrange
  const { hook, renderers } = await pluginFixture(t);
  const sessionId = randomUUID();
  const ctx = { sessionManager: { getSessionId: () => sessionId } };

  // Act
  const result = await hook({ reason: "prompt", prompt: "Verifier work level: quick tweak\nRename.", systemPrompt: ["Existing policy."] }, ctx);
  const handle = result.message.content.match(/--request ([0-9a-f.-]+)/)[1];
  const intent = await readRequestIntent(handle);
  t.after(() => rm(dirname(intent.path), { recursive: true, force: true }));
  const renderer = renderers.get(result.message.customType);
  const collapsed = renderer(result.message, { expanded: false });
  const expanded = renderer(result.message, { expanded: true });
  collapsed.invalidate();

  // Assert
  assert.deepEqual(collapsed.render(80), []);
  assert.deepEqual(expanded.render(160), []);
  assert.deepEqual([...renderers.keys()], ["verifier-work-intent"]);
  assert.equal(result.message.customType, "verifier-work-intent");
  assert.equal(result.message.display, true);
  assert.equal(result.message.attribution, "agent");
  assert.equal(intent.level, "quick-tweak");
  assert.ok(result.message.content.slice(0, 120).includes(`quick-tweak --request ${handle}`));
  assert.match(result.message.content, /For applicable PR\/MR source review only: .* automatic --base <actual-PR-base> <current-edited-path\.\.\.> --request/);
  assert.match(result.message.content, /--full/);
  assert.match(result.message.content, /not PASS.*mandatory.*explicit verification.*initial delivery\/release.*semantic escalation/);
  assert.equal(result.systemPrompt[0], "Existing policy.");
});

test("when a delivered PR is merged, the prompt does not make wrap-up and exit a verifier gate", async t => {
  // Arrange
  const { hook } = await pluginFixture(t);
  const sessionId = randomUUID();
  const event = {
    reason: "prompt",
    prompt: "The PR is merged and independently verified. Wrap up, remove its disposable worktree, and exit.",
    systemPrompt: ["Existing policy."],
  };
  const ctx = {
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };

  // Act
  const result = await hook(event, ctx);
  const handle = result.message.content.match(/--request ([0-9a-f.-]+)/)[1];
  const intent = await readRequestIntent(handle);
  t.after(() => rm(dirname(intent.path), {
    recursive: true,
    force: true,
  }));

  // Assert
  const prompt = result.systemPrompt.join("\n");
  assert.match(prompt, /Standalone status, cleanup, wrap-up and exit do not start verification or require a receipt/);
  assert.match(prompt, /Follow ordinary cleanup safety checks and authorized project wrappers/);
  assert.doesNotMatch(prompt, /closeout prepare|verifier_closeout/);
  assert.match(prompt, /before removing an edit-owning Git worktree with committed delivery changes awaiting final review/);
  assert.doesNotMatch(result.message.content, /automatic --request/);
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
  await assert.rejects(readRequestIntent(intent.handle));
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

test("when a persisted waiver is not an exact selector, reading rejects it even with a matching digest", async t => {
  const { intent } = await requestFixture(t, "Normal request.");
  const authority = await openRequestWaiverAuthority();
  t.after(authority.close);
  const record = JSON.parse(await readFile(intent.path, "utf8"));
  record.waiver = "verifier:resource-closeout\n";
  record.waiverAuthorityId = authority.id;
  const text = JSON.stringify(record);
  const currentPath = join(dirname(intent.path), "current.json");
  const pointer = JSON.parse(await readFile(currentPath, "utf8"));
  pointer.sha256 = createHash("sha256").update(text).digest("hex");
  await chmod(intent.path, 0o600);
  await writeFile(intent.path, text);
  await writeFile(currentPath, JSON.stringify(pointer));

  await assert.rejects(readRequestIntent(intent.handle), /changed, invalid, or superseded/);
});

test("when creating a request with a wildcard waiver, storage refuses the waiver", async () => {
  await assert.rejects(createRequestIntent({
    sessionId: randomUUID(),
    prompt: "Normal request.",
    waiver: "*",
  }), /exact Verifier gate selector/);
});

test("when creating a request with no authority, storage refuses the waiver", async () => {
  await assert.rejects(createRequestIntent({
    sessionId: randomUUID(),
    prompt: "Normal request.",
    waiver: "verification",
  }), /requires a session authority/);
});

async function runIntentHook(t, hook, ctx, prompt) {
  const response = await hook({
    reason: "prompt",
    prompt,
    systemPrompt: [],
  }, ctx);
  const handle = response.message.content.match(/--request ([0-9a-f.-]+)/)[1];
  const intent = await readRequestIntent(handle);
  t.after(() => rm(dirname(intent.path), {
    recursive: true,
    force: true,
  }));
  return {
    intent,
    response,
  };
}

test("when the user confirms a named waiver, it applies only to the next prompt and its revive", async t => {
  const { hook, command } = await pluginFixture(t);
  const sessionId = randomUUID();
  const ctx = {
    hasUI: true,
    sessionManager: {
      getSessionId: () => sessionId,
    },
    ui: {
      async confirm(title, message) {
        assert.match(title, /Waive a Verifier gate/);
        assert.match(message, /"verifier:resource-closeout" for the next prompt in this session/);
        return true;
      },
      notify() {},
    },
  };
  await command("waive verifier:resource-closeout", ctx);

  const { intent, response } = await runIntentHook(t, hook, ctx, "Continue cleanup.");
  assert.equal(intent.waiver, "verifier:resource-closeout");
  assert.match(response.message.content, /Verifier gate "verifier:resource-closeout" is waived by user for this request/);
  assert.match(response.systemPrompt.join("\n"), /not merge approval/);

  const revived = await hook({
    reason: "revive",
    prompt: "",
    systemPrompt: [],
  }, ctx);
  assert.equal(revived.message.content, response.message.content);

  const next = await runIntentHook(t, hook, ctx, "Continue cleanup.");
  assert.equal(Object.hasOwn(next.intent, "waiver"), false);
  assert.match(next.response.message.content, /Earlier waivers are not authority/);
  await assert.rejects(readRequestIntent(intent.handle), /superseded by a later prompt/);
});

test("when the user selects live session scope, the selected gate persists in that session until it switches", async t => {
  const { hook, command, events } = await pluginFixture(t);
  let sessionId = randomUUID();
  const ctx = {
    hasUI: true,
    sessionManager: {
      getSessionId: () => sessionId,
    },
    ui: {
      async confirm(_title, message) {
        assert.match(message, /"verification" for each prompt in this live session/);
        return true;
      },
      notify() {},
    },
  };
  await command("waive verification --session", ctx);

  const first = await runIntentHook(t, hook, ctx, "First task.");
  const second = await runIntentHook(t, hook, ctx, "Second task.");
  assert.equal(first.intent.waiver, "verification");
  assert.equal(second.intent.waiver, "verification");

  sessionId = randomUUID();
  await events.get("session_switch")({}, ctx);
  const switched = await runIntentHook(t, hook, ctx, "Unrelated task.");
  assert.equal(Object.hasOwn(switched.intent, "waiver"), false);
});

test("when no interactive confirmation grants a waiver, commands or lookalike chat cannot authorize one", async t => {
  const { hook, command } = await pluginFixture(t);
  const sessionId = randomUUID();
  const notices = [];
  const ctx = {
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
    },
    ui: {
      async confirm() {
        assert.fail("Non-interactive commands must not request confirmation");
      },
      notify(message) {
        notices.push(message);
      },
    },
  };
  await command("waive verification", ctx);
  assert.match(notices.at(-1), /requires user confirmation in the active session UI/);

  ctx.hasUI = true;
  await command("waive * --session", ctx);
  assert.match(notices.at(-1), /Usage: \/verifier waive/);

  ctx.ui.confirm = async () => false;
  await command("waive verification", ctx);
  assert.equal(notices.at(-1), "Verifier waiver not granted.");

  const { intent } = await runIntentHook(t, hook, ctx, "/verifier waive verification");
  assert.equal(Object.hasOwn(intent, "waiver"), false);
});

test("when the session resets during confirmation, a late response cannot grant a waiver", async t => {
  const { hook, command, events } = await pluginFixture(t);
  const sessionId = randomUUID();
  const notices = [];
  const ctx = {
    hasUI: true,
    sessionManager: {
      getSessionId: () => sessionId,
    },
    ui: {
      async confirm() {
        await events.get("session_clear")({}, ctx);
        return true;
      },
      notify(message) {
        notices.push(message);
      },
    },
  };
  await command("waive verifier:project-lint", ctx);
  assert.match(notices.at(-1), /not granted because the active session changed/);

  const { intent } = await runIntentHook(t, hook, ctx, "Fresh task.");
  assert.equal(Object.hasOwn(intent, "waiver"), false);
});

test("when a closeout waiver applies, the native closeout tool does not read a receipt or prepare a handoff", async t => {
  const { hook, command, events, tools } = await pluginFixture(t);
  const sessionId = randomUUID();
  const ctx = {
    agent: {
      kind: "main",
    },
    hasUI: true,
    sessionManager: {
      getSessionId: () => sessionId,
    },
    ui: {
      async confirm() {
        return true;
      },
      notify() {},
    },
  };
  await command("waive verifier:resource-closeout", ctx);
  const { intent } = await runIntentHook(t, hook, ctx, "Continue cleanup.");
  const closeout = tools.get("verifier_closeout");

  const result = await closeout.execute("call-id", {
    repositoryRoot: "/nonexistent-waived-repository",
    receiptPaths: ["/nonexistent-waived-receipt"],
  }, undefined, undefined, ctx);
  assert.equal(result.details.status, "WAIVED");
  assert.equal(result.details.handoffId, undefined);
  assert.deepEqual(result.details.receipts, []);
  assert.match(result.content[0].text, /waived by user for this request/);

  await events.get("session_shutdown")({}, ctx);
  assert.equal(Object.hasOwn(await readRequestIntent(intent.handle), "waiver"), false);
});

test("when the host dies unexpectedly, the persisted handle no longer authorizes a waiver", async t => {
  const intentModule = new URL("../omp-plugin/request-intent.js", import.meta.url);
  const script = `
    import { createRequestIntent, openRequestWaiverAuthority } from ${JSON.stringify(intentModule.href)};
    const authority = await openRequestWaiverAuthority();
    const intent = await createRequestIntent({
      sessionId: ${JSON.stringify(randomUUID())},
      prompt: "Continue cleanup.",
      waiver: "verifier:resource-closeout",
      waiverAuthorityId: authority.id,
    });
    process.stdout.write(JSON.stringify({
      handle: intent.handle,
      path: intent.path,
      authorityId: authority.id,
    }));
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script]);
  const exited = once(child, "exit");
  t.after(async () => {
    child.kill();
    await exited;
  });
  const [data] = await Promise.race([
    once(child.stdout, "data"),
    exited.then(([code]) => {
      throw new Error(`Waiver fixture process exited before showing its handle (status ${code}).`);
    }),
  ]);
  const { handle, path, authorityId } = JSON.parse(data);
  const requestDirectory = dirname(path);
  t.after(async () => {
    await rm(requestDirectory, {
      recursive: true,
      force: true,
    });
    await rm(join(dirname(requestDirectory), `${authorityId}.sock`), {
      force: true,
    });
  });
  assert.equal((await readRequestIntent(handle)).waiver, "verifier:resource-closeout");

  child.kill("SIGKILL");
  await exited;
  assert.equal(Object.hasOwn(await readRequestIntent(handle), "waiver"), false);
});

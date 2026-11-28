import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateSemanticCitations } from "#root/omp-plugin/semantic-citations.js";
import { captureSemanticContext } from "#root/omp-plugin/semantic-context.js";
import { semanticContextMissing } from "#root/omp-plugin/semantic-context-missing.js";
import { completeSemanticEvaluation, prepareSemanticEvaluation, readSemanticEvaluation, recordSemanticReviewPage } from "#root/omp-plugin/semantic-evaluations.js";
import { buildSemanticReviewPage } from "#root/omp-plugin/semantic-review-pages.js";
import { discoverVerificationChecks } from "#root/omp-plugin/verification-catalog.js";

const URL = "https://raw.githubusercontent.com/example/contracts/0123456789abcdef0123456789abcdef01234567/docs/approval.md";
const SOURCE = "# Approval Contract\nAlways ask for restricted paths.\nHeadless requests are refused.\n";
const CLI = fileURLToPath(import.meta.resolve("#root/bin/omp-verifier.js"));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-external-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagePath = join(root, "plugins", "publisher");
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(root, "README.md"), "# Integration\nRestricted paths always require approval.\n");
  await writeFile(join(packagePath, "standard.md"), "Integration claims must agree with the authoritative contract.\n");
  await writeFile(join(packagePath, "contract.json"), JSON.stringify({
    version: 1,
    standardId: "publisher:docs",
    source: "./standard.md",
    gold: "Document the actual integration contract.",
    requiredContext: ["changed-code"],
    rubric: [{ id: "accuracy", question: "Do the integration claims agree with the upstream contract?" }],
  }));
  await writeFile(join(packagePath, "package.json"), JSON.stringify({
    name: "publisher", version: "1.0.0",
    omp: { extensions: ["./index.js"], verifications: [{
      id: "publisher:docs", label: "Documentation", description: "Assess integration claims.",
      mode: "agentic", contract: "./contract.json",
    }] },
  }));
  const { checks } = await discoverVerificationChecks({ packageDirectory: join(root, "plugins") });
  return { root, check: checks.find(check => check.id === "publisher:docs") };
}

function assessment(requestId) {
  return {
    requestId, status: "PASS", summary: "The integration accurately describes required approval.",
    rationale: "The changed README agrees with the captured upstream approval contract.",
    citations: [
      { path: "README.md", line: 2, quote: "Restricted paths always require approval." },
      { path: URL, line: 2, quote: "Always ask for restricted paths." },
    ],
  };
}

test("when pinned upstream evidence is admitted, review pages and final assessment retain provenance without refetching", async t => {
  // Arrange
  const { root, check } = await fixture(t);
  t.mock.method(globalThis, "fetch", async () => new Response(SOURCE));
  const prepared = await prepareSemanticEvaluation({ cwd: root, check, changedPaths: ["README.md"] });

  // Act
  const recovered = await readSemanticEvaluation({ cwd: root, requestPath: prepared.reviewRequest.path, externalContextPaths: [`${URL}#L2-L3`] });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("network is now unavailable"); });
  const page = buildSemanticReviewPage(recovered, 0);
  await recordSemanticReviewPage({ cwd: root, page });
  const completed = await completeSemanticEvaluation({ cwd: root, requestPath: recovered.reviewRequest.path, assessment: assessment(recovered.reviewRequest.requestId) });

  // Assert
  assert.equal(recovered.status, "PENDING");
  assert.deepEqual(recovered.reviewRequest.scope.changedPaths, ["README.md"]);
  assert.deepEqual(recovered.reviewRequest.context.externalContext, [{
    path: URL,
    state: "present",
    source: "external-context",
    sha256: createHash("sha256").update(SOURCE).digest("hex"),
    lineCount: 4,
    startLine: 2,
    partial: true,
    omittedRanges: [[1, 1], [4, 4]],
    content: "Always ask for restricted paths.\nHeadless requests are refused.",
    selector: `${URL}#L2-L3`,
    revision: "0123456789abcdef0123456789abcdef01234567",
  }]);
  assert.equal(completed.status, "PASS");
  assert.throws(() => validateSemanticCitations([{ path: URL, line: 1, quote: "Always ask for restricted paths." }], recovered.reviewRequest.context), /does not match/);
});

test("when local source changes after external admission, pinned evidence does not bypass freshness", async t => {
  // Arrange
  const { root, check } = await fixture(t);
  t.mock.method(globalThis, "fetch", async () => new Response(SOURCE));
  const prepared = await prepareSemanticEvaluation({ cwd: root, check, changedPaths: ["README.md"] });
  const recovered = await readSemanticEvaluation({ cwd: root, requestPath: prepared.reviewRequest.path, externalContextPaths: [URL] });
  await writeFile(join(root, "README.md"), "Restricted paths need no approval.\n");

  // Act
  const completed = await completeSemanticEvaluation({ cwd: root, requestPath: recovered.reviewRequest.path, assessment: assessment(recovered.reviewRequest.requestId) });

  // Assert
  assert.equal(completed.status, "BLOCKED");
  assert.match(completed.evidence, /context changed/);
});

test("when upstream evidence is unavailable, a source verdict is blocked and explicit recovery retains the full scope", async t => {
  // Arrange
  const { root, check } = await fixture(t);
  t.mock.method(globalThis, "fetch", async () => new Response("Not Found", { status: 404 }));
  const prepared = await prepareSemanticEvaluation({ cwd: root, check, changedPaths: ["README.md"] });
  const unavailable = await readSemanticEvaluation({ cwd: root, requestPath: prepared.reviewRequest.path, externalContextPaths: [URL] });

  // Act
  const rejected = await completeSemanticEvaluation({ cwd: root, requestPath: unavailable.reviewRequest.path, assessment: assessment(unavailable.reviewRequest.requestId) });
  t.mock.method(globalThis, "fetch", async () => new Response(SOURCE));
  const recovered = await readSemanticEvaluation({ cwd: root, requestPath: unavailable.reviewRequest.path, removeContextPaths: [URL], externalContextPaths: [URL] });

  // Assert
  assert.equal(rejected.status, "BLOCKED");
  assert.match(unavailable.reviewRequest.missingContext.join("\n"), /external evidence.*HTTP 404/);
  assert.deepEqual(recovered.reviewRequest.scope.changedPaths, ["README.md"]);
  assert.deepEqual(recovered.reviewRequest.missingContext, []);
  assert.equal(recovered.reviewRequest.context.externalContext[0].content, SOURCE);
});

for (const url of [URL.replace("raw.githubusercontent.com", "localhost"), URL.replace("0123456789abcdef0123456789abcdef01234567", "main"), `${URL}?token=secret`, URL.replace("/docs/", "/../")]) {
  test(`when external selection is outside the pinned public source boundary (${url}), capture rejects it before fetching`, async t => {
    // Arrange
    const { root } = await fixture(t);
    t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });

    // Act / Assert
    await assert.rejects(captureSemanticContext({ repositoryRoot: root, changedPaths: ["README.md"], externalContextPaths: [url] }), /external context supports only/);
  });
}

test("when a URL is supplied as local context, the diagnostic distinguishes external evidence from a missing project file", async t => {
  // Arrange
  const { root } = await fixture(t);

  // Act / Assert
  await assert.rejects(captureSemanticContext({ repositoryRoot: root, changedPaths: ["README.md"], contextPaths: [URL] }), /external evidence, not a project file/);
  await assert.rejects(captureSemanticContext({ repositoryRoot: root, changedPaths: ["README.md"], contextPaths: ["../outside.md"] }), /stay inside the project/);
});

for (const [description, body, selector, reason] of [
  ["oversized source", "x".repeat(256_001), `${URL}#L1`, /retrieval limit/],
  ["oversized excerpt", "x".repeat(16_001), URL, /evidence limit/],
  ["binary source", "hello\0world", URL, /not text/],
  ["invalid UTF-8", new Uint8Array([255]), URL, /capture failed/],
  ["absent range", SOURCE, `${URL}#L10-L11`, /beyond end/],
]) {
  test(`when external evidence has ${description}, capture cannot establish completeness`, async t => {
    // Arrange
    const { root } = await fixture(t);
    t.mock.method(globalThis, "fetch", async () => new Response(body));

    // Act
    const captured = await captureSemanticContext({ repositoryRoot: root, changedPaths: ["README.md"], externalContextPaths: [selector] });

    // Assert
    assert.equal(captured.context.externalContext[0].state, "unavailable");
    assert.match(semanticContextMissing(["changed-code"], captured).join("\n"), reason);
  });
}

async function localGitFixture(t) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "omp-verifier-private-"));
  t.after(() => rm(repositoryRoot, {
    recursive: true,
    force: true,
  }));
  await writeFile(join(repositoryRoot, "contract.md"), SOURCE);
  await symlink("contract.md", join(repositoryRoot, "link.md"));
  const options = {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  execFileSync("git", ["init", "--quiet"], options);
  execFileSync("git", ["add", "contract.md", "link.md"], options);
  execFileSync("git", ["-c", "user.name=Verifier Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Pin synthetic contract"], options);
  const revision = execFileSync("git", ["rev-parse", "HEAD"], options).trim();
  const sourceURL = `git+${pathToFileURL(repositoryRoot).href}?revision=${revision}&path=contract.md`;
  return {
    repositoryRoot,
    revision,
    sourceURL,
  };
}

test("when private Git and public evidence are selected, one complete review retains both immutable sources", async t => {
  // Arrange
  const { root, check } = await fixture(t);
  const { repositoryRoot, revision, sourceURL } = await localGitFixture(t);
  await writeFile(join(repositoryRoot, "contract.md"), "Uncommitted content must not be reviewed.\n");
  t.mock.method(globalThis, "fetch", async () => new Response(SOURCE));
  const prepared = await prepareSemanticEvaluation({
    cwd: root,
    check,
    changedPaths: ["README.md"],
  });

  // Act
  const recovered = await readSemanticEvaluation({
    cwd: root,
    requestPath: prepared.reviewRequest.path,
    externalContextPaths: [URL, `${sourceURL}#L2-L3`],
  });
  await rm(repositoryRoot, {
    recursive: true,
    force: true,
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("network unavailable"); });
  const page = buildSemanticReviewPage(recovered, 0);
  await recordSemanticReviewPage({
    cwd: root,
    page,
  });
  const result = assessment(recovered.reviewRequest.requestId);
  result.citations.push({
    path: sourceURL,
    line: 2,
    quote: "Always ask for restricted paths.",
  });
  const completed = await completeSemanticEvaluation({
    cwd: root,
    requestPath: recovered.reviewRequest.path,
    assessment: result,
  });

  // Assert
  const privateRecord = recovered.reviewRequest.context.externalContext[1];
  assert.equal(recovered.status, "PENDING");
  assert.deepEqual(recovered.reviewRequest.missingContext, []);
  assert.equal(privateRecord.revision, revision);
  assert.equal(privateRecord.sha256, createHash("sha256").update(SOURCE).digest("hex"));
  assert.equal(privateRecord.startLine, 2);
  assert.equal(privateRecord.content, "Always ask for restricted paths.\nHeadless requests are refused.");
  assert.equal(completed.status, "PASS");
});

test("when captured private evidence is altered, the saved review cannot be reused", async t => {
  // Arrange
  const { root, check } = await fixture(t);
  const { sourceURL } = await localGitFixture(t);
  const prepared = await prepareSemanticEvaluation({
    cwd: root,
    check,
    changedPaths: ["README.md"],
  });
  const recovered = await readSemanticEvaluation({
    cwd: root,
    requestPath: prepared.reviewRequest.path,
    externalContextPaths: [sourceURL],
  });
  const stored = JSON.parse(await readFile(recovered.reviewRequest.path, "utf8"));
  stored.payload.context.externalContext[0].revision = "0".repeat(40);
  await writeFile(recovered.reviewRequest.path, JSON.stringify(stored));

  // Act
  const result = await readSemanticEvaluation({
    cwd: root,
    requestPath: recovered.reviewRequest.path,
  });

  // Assert
  assert.equal(result.status, "BLOCKED");
  assert.match(result.evidence, /integrity|tamper|signature/i);
});

test("when a selected Git path is a symlink or missing, capture retains an explicit evidence prerequisite", async t => {
  // Arrange
  const { root } = await fixture(t);
  const { sourceURL } = await localGitFixture(t);

  // Act
  const captured = await captureSemanticContext({
    repositoryRoot: root,
    changedPaths: ["README.md"],
    externalContextPaths: [sourceURL.replace("path=contract.md", "path=link.md"), sourceURL.replace("path=contract.md", "path=missing.md")],
  });

  // Assert
  assert.deepEqual(captured.context.externalContext.map(record => record.state), ["unavailable", "unavailable"]);
  assert.match(semanticContextMissing(["changed-code"], captured).join("\n"), /not a regular committed file/);
});

test("when a private selector escapes its Git tree or uses a mutable ref, capture rejects the selection", async t => {
  // Arrange
  const { root } = await fixture(t);
  const { sourceURL, revision } = await localGitFixture(t);
  const invalidSelectors = [
    sourceURL.replace(revision, "HEAD"),
    sourceURL.replace("path=contract.md", "path=../secret"),
    sourceURL.replace("path=contract.md", "path=%2Fetc%2Fpasswd"),
    `${sourceURL}&token=secret`,
  ];

  // Act / Assert
  for (const selector of invalidSelectors) {
    await assert.rejects(captureSemanticContext({
      repositoryRoot: root,
      changedPaths: ["README.md"],
      externalContextPaths: [selector],
    }), /local Git context requires/);
  }
});

async function selectorFixture(t) {
  const { root, check } = await fixture(t);
  const { sourceURL } = await localGitFixture(t);
  const contextPaths = [];
  for (let index = 0; index < 30; index += 1) {
    const path = `dependency-${index}.md`;
    await writeFile(join(root, path), `Dependency ${index} requires approval.\n`);
    contextPaths.push(path);
  }
  const prepared = await prepareSemanticEvaluation({
    cwd: root,
    check,
    changedPaths: ["README.md"],
  });
  return {
    root,
    prepared,
    contextPaths,
    sourceURL,
  };
}

for (const outcome of ["PASS", "FAIL", "stale"]) {
  test(`when thirty-one mixed selectors are explicitly admitted, complete review preserves ${outcome}`, async t => {
    // Arrange
    const { root, prepared, contextPaths, sourceURL } = await selectorFixture(t);
    const recovered = await readSemanticEvaluation({
      cwd: root,
      requestPath: prepared.reviewRequest.path,
      contextPaths,
      externalContextPaths: [`${sourceURL}#L2-L3`],
      maxContextPaths: 31,
    });
    const review = recovered.reviewRequest;
    const firstPage = buildSemanticReviewPage(recovered);
    for (let index = 0; index < firstPage.count; index += 1) {
      const page = buildSemanticReviewPage(recovered, index);
      await recordSemanticReviewPage({
        cwd: root,
        page,
      });
    }
    const result = {
      requestId: review.requestId,
      status: outcome === "FAIL" ? "FAIL" : "PASS",
      summary: "The selected document was assessed against the captured contracts.",
      rationale: "All selected dependency contracts require approval, and the changed document describes that requirement.",
      citations: [
        {
          path: "README.md",
          line: 2,
          quote: "Restricted paths always require approval.",
        },
        {
          path: sourceURL,
          line: 2,
          quote: "Always ask for restricted paths.",
        },
      ],
    };
    if (outcome === "FAIL") {
      result.summary = "The selected document omits the headless restriction.";
      result.rationale = "The captured upstream contract refuses headless requests, but the changed integration document describes only approval.";
      result.findings = [{
        path: "README.md",
        summary: "Document the headless restriction from the captured contract.",
      }];
    }
    if (outcome === "stale") {
      await writeFile(join(root, contextPaths[0]), "Dependency policy changed after capture.\n");
    }

    // Act
    const completed = await completeSemanticEvaluation({
      cwd: root,
      requestPath: review.path,
      assessment: result,
    });

    // Assert
    assert.equal(recovered.status, "PENDING");
    assert.deepEqual(review.scope.changedPaths, ["README.md"]);
    assert.deepEqual(review.missingContext, []);
    assert.equal(review.scope.maxContextPaths, 31);
    assert.deepEqual(review.context.targetedContext.map(record => record.path), contextPaths);
    assert.equal(review.context.externalContext[0].content, "Always ask for restricted paths.\nHeadless requests are refused.");
    assert.equal(completed.status, outcome === "stale" ? "BLOCKED" : outcome);
    if (outcome === "stale") assert.match(completed.evidence, /context changed/);
  });
}

test("when selector recovery exceeds its allowance, the pending request remains recoverable with an explicit larger bound", async t => {
  // Arrange
  const { root, prepared, contextPaths, sourceURL } = await selectorFixture(t);
  const options = {
    cwd: root,
    requestPath: prepared.reviewRequest.path,
    contextPaths,
    externalContextPaths: [`${sourceURL}#L2-L3`],
  };

  // Act
  const rejected = await readSemanticEvaluation(options);
  const recoveryArgs = contextPaths.flatMap(path => ["--context", path]);
  const recoveredOutput = execFileSync(process.execPath, [
    CLI,
    "review",
    prepared.reviewRequest.path,
    "--max-context-paths", "31",
    "--external-context", `${sourceURL}#L2-L3`,
    ...recoveryArgs,
  ], {
    cwd: root,
    encoding: "utf8",
  });
  const [recovered] = JSON.parse(recoveredOutput);
  const continued = await readSemanticEvaluation({
    cwd: root,
    requestPath: recovered.reviewRequest.path,
    continuation: true,
  });
  const reread = await readSemanticEvaluation({
    cwd: root,
    requestPath: continued.reviewRequest.path,
  });
  const overflow = await readSemanticEvaluation({
    cwd: root,
    requestPath: reread.reviewRequest.path,
    contextPaths: ["one-more.md"],
  });

  // Assert
  assert.equal(rejected.status, "BLOCKED");
  assert.match(rejected.evidence, /30 selectors.*review --max-context-paths/);
  assert.equal(recovered.status, "PENDING");
  assert.equal(continued.status, "PENDING");
  assert.equal(reread.reviewRequest.scope.maxContextPaths, 31);
  assert.deepEqual(reread.reviewRequest.missingContext, []);
  assert.equal(overflow.status, "BLOCKED");
  assert.match(overflow.evidence, /31 selectors/);
});

for (const maxContextPaths of [29, 257, 31.5, "64", null]) {
  test(`when selector allowance is invalid (${JSON.stringify(maxContextPaths)}), recovery rejects it without consuming the request`, async t => {
    // Arrange
    const { root, check } = await fixture(t);
    const prepared = await prepareSemanticEvaluation({
      cwd: root,
      check,
      changedPaths: ["README.md"],
    });

    // Act
    const rejected = await readSemanticEvaluation({
      cwd: root,
      requestPath: prepared.reviewRequest.path,
      maxContextPaths,
    });
    const pending = await readSemanticEvaluation({
      cwd: root,
      requestPath: prepared.reviewRequest.path,
    });

    // Assert
    assert.equal(rejected.status, "BLOCKED");
    assert.match(rejected.evidence, /safe integer from 30 through 256/);
    assert.equal(pending.status, "PENDING");
    assert.equal(pending.reviewRequest.requestId, prepared.reviewRequest.requestId);
  });
}

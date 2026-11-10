import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureSemanticContext, semanticContextMissing, validateSemanticCitations } from "#root/omp-plugin/semantic-context.js";
import { completeSemanticEvaluation, prepareSemanticEvaluation, readSemanticEvaluation, recordSemanticReviewPage } from "#root/omp-plugin/semantic-evaluations.js";
import { buildSemanticReviewPage } from "#root/omp-plugin/semantic-review-pages.js";
import { discoverVerificationChecks } from "#root/omp-plugin/verifications.js";

const URL = "https://raw.githubusercontent.com/example/contracts/0123456789abcdef0123456789abcdef01234567/docs/approval.md";
const SOURCE = "# Approval Contract\nAlways ask for restricted paths.\nHeadless requests are refused.\n";

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
    path: URL, state: "present", source: "external-context", sha256: createHash("sha256").update(SOURCE).digest("hex"),
    lineCount: 4, startLine: 2, partial: true, omittedRanges: [[1, 1], [4, 4]],
    content: "Always ask for restricted paths.\nHeadless requests are refused.",
    selector: `${URL}#L2-L3`, revision: "0123456789abcdef0123456789abcdef01234567",
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

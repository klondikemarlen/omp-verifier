import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  completeSemanticEvaluation,
  prepareSemanticEvaluation,
  readSemanticEvaluation,
} from "#root/omp-plugin/semantic-evaluations.js";
import { discoverVerificationChecks } from "#root/omp-plugin/verifications.js";

const CALLER_SOURCE = 'import { helper } from "./helper.js";\nexport const result = helper(1);\n';

function oversizedHelperSource() {
  const policies = Array.from({ length: 800 }, (_, index) =>
    `  ["event-${index}", { owner: "domain-${index % 9}", enabled: true }],`);
  return `export const policies = new Map([\n${policies.join("\n")}\n]);\n`;
}

async function createSemanticFixture({ helperSource = "export const helper = value => value;\n" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-guidance-"));
  const packagePath = join(root, "plugins", "publisher");
  await mkdir(packagePath, { recursive: true });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "helper.js"), helperSource);
  await writeFile(join(root, "src", "caller.js"), CALLER_SOURCE);
  await writeFile(join(root, "AGENTS.md"), "Keep meaningful policy ownership at module boundaries.\n");
  await writeFile(join(packagePath, "standard.md"), "A module owns an invariant, not forwarding alone.\n");
  await writeFile(join(packagePath, "contract.json"), JSON.stringify({
    version: 1,
    standardId: "publisher:alignment",
    source: "./standard.md",
    gold: "Modules own meaningful invariants.",
    requiredContext: ["changed-code", "callers", "siblings", "project-guidance"],
    rubric: [{ id: "ownership", question: "Which invariant is owned here?" }],
  }));
  await writeFile(join(packagePath, "package.json"), JSON.stringify({
    name: "publisher",
    version: "1.0.0",
    omp: {
      extensions: ["./index.js"],
      verifications: [{
        id: "publisher:alignment",
        label: "Module Boundary Alignment",
        description: "Assesses declared boundary ownership.",
        mode: "agentic",
        contract: "./contract.json",
        pathTriggers: ["**/*.js"],
      }],
    },
  }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Verifier Tests", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "baseline"], { cwd: root });
  return { root, packageDirectory: join(root, "plugins") };
}

async function discoverSemanticCheck(fixture) {
  const discovery = await discoverVerificationChecks({ packageDirectory: fixture.packageDirectory });
  return discovery.checks.find(check => check.id === "publisher:alignment");
}

function citationFor(path, source, line) {
  return { path, line, quote: source.split("\n")[line - 1] };
}

function passAssessment(requestId, citation = { path: "src/helper.js", line: 1, quote: "export const helper = value => value;" }) {
  return {
    requestId,
    status: "PASS",
    summary: "The changed module owns its policy mapping.",
    rationale: "Captured policy data defines the domain ownership invariant.",
    citations: [citation],
  };
}

function sourceRangeSelectors(path, lineCount) {
  const selectors = [];
  for (let start = 1; start <= lineCount; start += 180) {
    selectors.push(`${path}#L${start}-L${Math.min(start + 179, lineCount)}`);
  }
  return selectors;
}

test("when changed source and material guidance are recovered, unrelated caller candidates do not expand required guidance", async () => {
  // Arrange
  const source = oversizedHelperSource();
  const fixture = await createSemanticFixture({ helperSource: source });

  try {
    await mkdir(join(fixture.root, "services"));
    await writeFile(join(fixture.root, "services", "consumer.js"), CALLER_SOURCE);
    await writeFile(join(fixture.root, "services", "README.md"), "Consumers own orchestration, not forwarding boundaries.\n".repeat(400));
    for (let index = 0; index < 45; index += 1) {
      const directory = join(fixture.root, "unrelated", String(index));
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "candidate.js"), "// A helper is mentioned, but this is not a material dependency.\n");
      await writeFile(join(directory, "README.md"), "Unrelated guide.\n".repeat(20_000));
    }
    await mkdir(join(fixture.root, "noise"));
    for (let index = 0; index < 1_205; index += 1) {
      await writeFile(join(fixture.root, "noise", `${index}.js`), "export const noise = true;\n");
    }
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
    });

    // Act
    const changedRecovery = await readSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      contextPaths: sourceRangeSelectors("src/helper.js", source.split("\n").length),
    });
    const materialRecovery = await readSemanticEvaluation({
      cwd: fixture.root,
      requestPath: changedRecovery.reviewRequest.path,
      contextPaths: ["services/consumer.js", "services/README.md#L130-L150", "src/caller.js"],
    });
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: materialRecovery.reviewRequest.path,
      assessment: passAssessment(materialRecovery.reviewRequest.requestId, citationFor("src/helper.js", source, 4)),
    });

    // Assert
    assert.equal(materialRecovery.reviewRequest.context.changedCodeCoverage[0].complete, true);
    assert.equal(materialRecovery.reviewRequest.context.sourceInventory.complete, false);
    assert.deepEqual(materialRecovery.reviewRequest.missingContext, []);
    assert.ok(materialRecovery.reviewRequest.context.guidanceRequirements.some(record =>
      record.path === "services/README.md" && record.requiredBy.includes("services/consumer.js")));
    assert.equal(materialRecovery.reviewRequest.context.guidanceRequirements.some(record => record.path.startsWith("unrelated/")), false);
    assert.equal(completed.status, "PASS");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when required guidance cannot coexist with explicit evidence, the blocker names the exact capacity and boundary", async () => {
  // Arrange
  const fixture = await createSemanticFixture();

  try {
    await writeFile(join(fixture.root, "README.md"), `${"Owning guidance. ".repeat(900)}\n`);
    const contextPaths = [];
    for (let index = 0; index < 8; index += 1) {
      const path = `src/context-${index}.js`;
      contextPaths.push(path);
      await writeFile(join(fixture.root, path), `// ${"material ".repeat(1_660)}\n`);
    }

    // Act
    const prepared = await prepareSemanticEvaluation({
      check: await discoverSemanticCheck(fixture),
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
      contextPaths,
    });
    const completed = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: prepared.reviewRequest.path,
      assessment: passAssessment(prepared.reviewRequest.requestId),
    });

    // Assert
    assert.equal(completed.status, "BLOCKED");
    assert.match(completed.evidence, /README.md \(128000-byte evidence limit reached/);
    assert.match(completed.evidence, /required by src\/helper.js/);
    assert.ok(prepared.reviewRequest.context.evidenceBudget.records.some(record => record.path === "src/context-0.js"));
    assert.ok(prepared.reviewRequest.context.evidenceBudget.rejections.some(record => record.path === "README.md"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

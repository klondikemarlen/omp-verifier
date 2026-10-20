import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url));

test("when one named check applies, CLI verification excludes an unrelated failing check", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-named-cli-"));
  const agentDirectory = join(root, "agent");
  const packageDirectory = join(root, "plugins", "node_modules", "publisher");

  try {
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(root, "plugins", "package.json"), JSON.stringify({
      name: "omp-plugins",
      dependencies: { publisher: "1.0.0" },
    }));
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
      name: "publisher",
      omp: {
        extensions: ["./index.js"],
        verifications: [
          { id: "publisher:selected", label: "Selected", description: "The applicable manual check", entry: "./selected.mjs" },
          { id: "publisher:unrelated", label: "Unrelated", description: "An unrelated manual check", entry: "./unrelated.mjs" },
        ],
      },
    }));
    await writeFile(join(packageDirectory, "selected.mjs"), 'process.stdout.write(JSON.stringify({ status: "PASS", summary: "Selected Gold met", evidence: "selected command executed" }));\n');
    await writeFile(join(packageDirectory, "unrelated.mjs"), 'process.stdout.write(JSON.stringify({ status: "FAIL", summary: "Unrelated violation" })); process.exitCode = 1;\n');

    // Act
    const result = spawnSync(process.execPath, [cliPath, "verify", "publisher:selected"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
    });

    // Assert
    assert.deepEqual(JSON.parse(result.stdout), [{
      id: "publisher:selected",
      status: "PASS",
      summary: "Selected Gold met",
      evidence: "selected command executed",
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("when a named CLI check is unavailable, blocks instead of claiming verification passed", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-unknown-cli-"));

  try {
    // Act
    const result = spawnSync(process.execPath, [cliPath, "verify", "publisher:missing"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") },
    });

    // Assert
    assert.deepEqual(JSON.parse(result.stdout), [{
      id: "publisher:missing",
      status: "BLOCKED",
      summary: "Verification check is not installed",
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("when a check exits nonzero with BLOCKED, preserves its prerequisite details", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-blocked-exit-"));
  const packageDirectory = join(root, "plugins", "node_modules", "publisher");

  try {
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
      name: "publisher",
      omp: {
        extensions: ["./index.js"],
        verifications: [
          { id: "publisher:blocked", label: "Blocked", description: "An unavailable comparison base", entry: "./blocked.mjs" },
        ],
      },
    }));
    await writeFile(join(packageDirectory, "blocked.mjs"), `
process.stdout.write(JSON.stringify({
  status: "BLOCKED",
  summary: "Changed files could not be inspected.",
  evidence: "The requested comparison base is unavailable.",
  nextCheck: "Fetch the comparison base and rerun the check."
}));
process.exitCode = 1;
`);

    // Act
    const result = spawnSync(process.execPath, [cliPath, "verify", "publisher:blocked"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") },
    });

    // Assert
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), [{
      id: "publisher:blocked",
      status: "BLOCKED",
      summary: "Changed files could not be inspected.",
      evidence: "The requested comparison base is unavailable.",
      nextCheck: "Fetch the comparison base and rerun the check.",
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("when a check reports PASS but exits nonzero, blocks verification", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-contradictory-exit-"));
  const packageDirectory = join(root, "plugins", "node_modules", "publisher");

  try {
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
      name: "publisher",
      omp: {
        extensions: ["./index.js"],
        verifications: [
          { id: "publisher:contradictory", label: "Contradictory", description: "A failed process claiming PASS", entry: "./contradictory.mjs" },
        ],
      },
    }));
    await writeFile(join(packageDirectory, "contradictory.mjs"), 'process.stdout.write(JSON.stringify({ status: "PASS", summary: "No violation reported" })); process.exitCode = 1;\n');

    // Act
    const result = spawnSync(process.execPath, [cliPath, "verify", "publisher:contradictory"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") },
    });

    // Assert
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout)[0].status, "BLOCKED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

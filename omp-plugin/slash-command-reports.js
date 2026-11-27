import { formatRunTimings, formatVerificationResults } from "#root/omp-plugin/reporters.js";
import packageManifest from "../package.json" with { type: "json" };

export function formatVerifierStatus(status, { details = false } = {}) {
  const { globalNames, projectNames, isGuidanceInstalled, generation } = status;
  const hasGlobalVerifier = globalNames?.includes("verifier") === true;
  const lines = [`Loaded plugin: ${packageManifest.version}`];
  if (hasGlobalVerifier) {
    lines.push("Global verifier: Configured");
  } else {
    lines.push("Global verifier: Not configured");
  }
  if (isGuidanceInstalled) {
    lines.push("Advisor guidance: Installed");
  } else {
    lines.push("Advisor guidance: Missing");
  }
  if (projectNames === null) {
    lines.push("Project roster: No project-specific roster");
  } else {
    lines.push("Project roster: Present");
  }
  if (!hasGlobalVerifier || !isGuidanceInstalled) {
    lines.push("Restore managed setup: Start a fresh OMP session.");
  }
  if (!generation.value) {
    lines.push("Runtime generation: Unavailable. See /verifier generation status.");
  }
  lines.push("Live activity: Run /advisor status.");

  if (!details) {
    lines.push("Setup details: Run /verifier status --details.");
    return { title: "Verifier status", lines };
  }

  lines.push(
    `Global advisors: ${rosterNames(globalNames)}`,
    `Global roster path: ${status.globalPath}`,
    `Project advisors: ${rosterNames(projectNames)}`,
    `Project roster path: ${status.projectPath}`,
    `Guidance path: ${status.guidancePath}`,
  );
  if (generation.value) {
    lines.push(...generationIdentity(generation.value));
  } else {
    lines.push(`Generation error: ${generation.error}`);
  }

  return { title: "Verifier status details", lines };
}

export function formatSlashChecks({ checks, blockedResults }) {
  const lines = [];
  if (checks.length === 0) {
    lines.push("No usable verification checks found.");
  } else {
    lines.push(`Installed verification checks: ${checks.length}`);
  }
  if (blockedResults.length > 0) {
    lines.push(`Discovery blockers: ${blockedResults.length}`, formatVerificationResults(blockedResults));
  }

  for (const check of checks) {
    const mode = check.mode === "agentic" ? " [agentic]" : "";
    lines.push(`${check.id}${mode} — ${check.label}: ${check.description}`);
  }

  if (checks.length > 0) {
    lines.push("Run checks: /verifier verify");
  } else if (blockedResults.length === 0) {
    lines.push("Next: Install a plugin that declares verification checks.");
  }
  return lines.join("\n");
}

export function formatSlashTimings(runs) {
  if (runs.length === 0) {
    return "No recorded verification runs in this working directory.\nRun checks: /verifier verify";
  }

  return `Recent verification runs in this directory: ${runs.length}\n\n${formatRunTimings(runs)}`;
}

export function formatSlashGeneration(action, result) {
  if (action === "collect") {
    if (result.length === 0) {
      return "No verifier generations were removed.";
    }

    return [`Verifier generations removed: ${result.length}`, ...result].join("\n");
  }

  const lines = [];
  if (action === "prepare") {
    lines.push("Verifier generation prepared; the active generation did not change.");
  } else if (action === "activate") {
    lines.push("Verifier generation activated for new runs.");
  } else {
    lines.push("Active verifier generation selected for new runs:");
  }
  lines.push(...generationIdentity(result));
  if (action === "prepare") {
    lines.push(`Activate: /verifier generation activate ${result.id}`);
  } else if (action !== "activate") {
    lines.push(`Coordinator source: ${result.sourcePackage}`);
    lines.push(`Provider package directory: ${result.packageDirectory}`);
    for (const provider of result.identity.packages) {
      if (provider.package === "omp-verifier") continue;
      lines.push(`Provider: ${provider.package} ${provider.version}`);
    }
  }
  return lines.join("\n");
}

export function formatSlashCloseoutReceipt(receipt) {
  return [
    "Closeout receipt prepared; this is not PASS.",
    `Captured resources: ${receipt.resourceCount}`,
    `Task: ${receipt.taskId}`,
    `Captured at: ${receipt.capturedAt}`,
    `Receipt: ${receipt.receiptPath}`,
    "After authorized cleanup or retention, check the receipt:",
    `/verifier closeout verify ${receipt.receiptPath}`,
  ].join("\n");
}

function rosterNames(names) {
  if (names === null) {
    return "Roster not present";
  }
  return names.join(", ") || "No advisor names found";
}

function generationIdentity(generation) {
  const coordinator = generation.identity.packages.find(provider => provider.package === "omp-verifier");
  return [
    `Coordinator version: ${coordinator?.version ?? "Unavailable"}`,
    `Generation ID: ${generation.id}`,
    `Generation digest: ${generation.identity.digest}`,
  ];
}

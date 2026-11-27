import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { registerCloseoutTool } from "#root/omp-plugin/closeout-tool.js";
import createVerifierCommandUsage from "#root/omp-plugin/create-verifier-command-usage.js";
import {
  collectGlobalVerifierStatus,
  installGlobalVerifier,
  uninstallGlobalVerifier,
} from "#root/omp-plugin/global-verifier.js";
import { presentLintAdvisor } from "#root/omp-plugin/lint-presentation.js";
import { registerAdvisorCheckWidget } from "#root/omp-plugin/register-advisor-check-widget.js";
import { formatVerificationResults } from "#root/omp-plugin/reporters.js";
import {
  createRequestIntent,
  isRequestWaiver,
  openRequestWaiverAuthority,
  readRequestIntent,
} from "#root/omp-plugin/request-intent.js";
import {
  registerVerifierStatusReport,
  showVerifierStatusReport,
} from "#root/omp-plugin/show-verifier-status-report.js";
import {
  formatSlashChecks,
  formatSlashCloseoutReceipt,
  formatSlashGeneration,
  formatSlashTimings,
  formatVerifierStatus,
} from "#root/omp-plugin/slash-command-reports.js";
import { discoverVerificationChecks } from "#root/omp-plugin/verification-catalog.js";
import { timeVerificationRun } from "#root/omp-plugin/run-timings.js";
import { runInstalledVerificationChecks } from "#root/omp-plugin/verifications.js";
import { runtimePaths } from "#root/omp-plugin/runtime-generations.js";

const WAIVER_USAGE = "/verifier waive <verification|namespace:name> [--session]";
const COMMAND_USAGE = "/verifier [status|checks|verify|timings|demo|uninstall|generation|closeout|waive]";
const STATUS_USAGE = "/verifier status [--details|--usage]";
const SUBCOMMANDS = [
  { name: "status", description: "Show verifier setup; use --details for paths or --usage for command counts" },
  { name: "checks", description: "List installed verification checks" },
  { name: "verify", description: "Run installed verification checks" },
  {
    name: "timings",
    description: "Show recent run and check durations",
  },
  { name: "demo", description: "Preview actual advisor cards without running checks" },
  { name: "uninstall", description: "Remove the verifier advisor" },
  {
    name: "generation",
    description: "Prepare, activate, inspect, or collect verifier artifacts",
  },
  {
    name: "closeout",
    description: "Capture or verify declared final resource dispositions",
  },
  {
    name: "waive",
    description: "Confirm a named Verifier waiver for the next prompt or live session",
  },
];
const commandUsage = createVerifierCommandUsage(SUBCOMMANDS.map(command => command.name));
const execute = promisify(execFile);

function executeRuntimeCommand(agentDir, cwd, args) {
  const paths = runtimePaths(agentDir);
  return execute("node", [paths.launcher, ...args], {
    cwd,
    timeout: 600_000,
    maxBuffer: 1_000_000,
  });
}

async function runtimeCommand(agentDir, cwd, args) {
  try {
    const { stdout } = await executeRuntimeCommand(agentDir, cwd, args);
    return { output: stdout.trimEnd(), level: "info", hasResult: true };
  } catch (error) {
    if (args[0] === "verify" && ["SIGINT", "SIGTERM"].includes(error.signal)) {
      return {
        output: `Verification interrupted by ${error.signal}.\nNext: Rerun the same /verifier verify command.`,
        level: "warning",
      };
    }
    if (error.stdout) {
      return {
        output: error.stdout.trimEnd(),
        level: "warning",
        hasResult: error.code === 1,
      };
    }

    return {
      output: `Verifier ${args[0]} could not complete.\n${error.stderr?.trimEnd() || error.message}`,
      level: "error",
    };
  }
}

function notifyRuntimeReport(ctx, result, format) {
  if (!format || !result.hasResult) {
    return ctx.ui.notify(result.output, result.level);
  }

  let report;
  try {
    report = format(JSON.parse(result.output));
  } catch {
    return ctx.ui.notify("Verifier returned an unreadable report. Retry in a fresh OMP session.", "error");
  }
  return ctx.ui.notify(report, result.level);
}

function verificationReport(output, args) {
  if (output) {
    return output;
  }
  if (args.includes("--failures-only")) {
    return "No results matched the failure-only filter. This is not proof of PASS.";
  }

  return "No verification checks applied. No verdict was recorded.";
}

async function buildVerification(cwd, ids, packageDirectory) {
  const results = await timeVerificationRun(cwd, "verify", () => runInstalledVerificationChecks({
    cwd,
    ids,
    packageDirectory,
  }));
  return formatVerificationResults(results);
}

async function showDemo(ctx) {
  if (!ctx.hasUI) {
    return ctx.ui.notify("Verifier preview unavailable.\nOpen an interactive OMP terminal to run /verifier demo.", "warning");
  }

  let advisor;
  let ui;
  try {
    [advisor, ui] = await Promise.all([
      import("@oh-my-pi/pi-tui/chat/advisor-message"),
      import("@oh-my-pi/pi-tui"),
    ]);
    if (typeof advisor.createAdvisorMessageCard !== "function") {
      throw new Error("OMP does not export its advisor-card renderer.");
    }
  } catch (error) {
    return ctx.ui.notify(`Verifier preview unavailable: ${error.message}\nUse an OMP version with the advisor-card renderer.`, "warning");
  }

  const samples = [
    {
      id: "demo:fail",
      status: "FAIL",
      summary: "Sample check found a violation.",
      evidence: "Sample: an unused variable was found in example.js.",
      nextCheck: "Example action: remove the unused variable and rerun the check.",
    },
    {
      id: "demo:blocked",
      status: "BLOCKED",
      summary: "Sample check could not run.",
      evidence: "Sample: a required development dependency was unavailable.",
      nextCheck: "Example action: restore the documented dependencies and retry.",
    },
  ];
  return ctx.ui.custom((tui, theme, _keybindings, done) => {
    const preview = new ui.Box(1, 0, undefined, {
      chars: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
      color: text => theme.fg("border", text),
    });
    let sampleIndex = 0;
    const showSample = () => {
      const sample = samples[sampleIndex];
      preview.clear();
      preview.addChild(new ui.Text(
        `Verifier demo — sample ${sampleIndex + 1}/${samples.length}: ${sample.status}`,
        0, 0,
      ));
      preview.addChild(new ui.Text(
        `${theme.bold("Controls")}  ${theme.bold(theme.fg("accent", "[Tab]"))} Next sample    `
        + `${theme.bold(theme.fg("accent", "[Esc] / [Enter]"))} Close`,
        0, 0,
      ));
      preview.addChild(advisor.createAdvisorMessageCard({
        notes: [{
          advisor: "verifier",
          severity: "blocker",
          note: `SAMPLE — not a project finding\n${formatVerificationResults([sample])}`,
        }],
      }, () => true, theme));
      preview.addChild(new ui.Text(
        "PASS is normally silent, not proof of success.\nPreview only: no checks run, advice sent, or verdicts recorded.",
        0, 0,
      ));
    };
    showSample();
    preview.handleInput = data => {
      if (ui.matchesKey(data, "escape") || ui.matchesKey(data, "enter") || ui.matchesKey(data, "ctrl+c")) {
        done();
      } else if (ui.matchesKey(data, "tab")) {
        sampleIndex = (sampleIndex + 1) % samples.length;
        showSample();
        tui.requestRender();
      }
    };
    return preview;
  });
}

function completeSubcommands(argumentPrefix) {
  const statusOption = argumentPrefix.match(/^status\s+(\S*)$/);
  if (statusOption) {
    const options = [
      { value: "status --details", label: "--details", description: "Show generation IDs and local paths" },
      { value: "status --usage", label: "--usage", description: "Show recorded command counts" },
    ];
    return options.filter(option => option.label.startsWith(statusOption[1]));
  }

  if (argumentPrefix.includes(" ")) return null;
  return SUBCOMMANDS
    .filter(command => command.name.startsWith(argumentPrefix.toLowerCase()))
    .map(command => ({ value: `${command.name} `, label: command.name, description: command.description }));
}

async function verifyCloseoutReceipt(agentDir, repositoryRoot, receiptPath) {
  const args = [
    "closeout",
    "verify",
    "--reporter",
    "json",
    "--",
    receiptPath,
  ];
  let output;
  let exitCode = 0;
  try {
    const result = await executeRuntimeCommand(agentDir, repositoryRoot, args);
    output = result.stdout;
  } catch (error) {
    if (error.code !== 1 || !error.stdout || error.stderr) {
      throw error;
    }
    exitCode = error.code;
    output = error.stdout;
  }
  const results = JSON.parse(output);
  if (results.length !== 1 || results[0]?.id !== "verifier:resource-closeout") {
    throw new Error("Installed verifier did not return the requested resource check");
  }
  if ((results[0].status === "PASS") !== (exitCode === 0)) {
    throw new Error("Closeout verdict disagrees with verifier exit status");
  }
  return results[0];
}

function logStartupTiming(pi, phase, startedAt) {
  // Diagnostics must not prevent startup or suppress the request's verifier instructions.
  try {
    const logger = pi.logger;
    if (!logger) return;

    const durationMs = Math.round(performance.now() - startedAt);
    logger.debug("verifier.startup-timing", {
      phase,
      durationMs,
    });
  } catch {
    // Host logging is best-effort.
  }
}

export default async function verifierPlugin(pi) {
  const loadStartedAt = performance.now();
  pi.setLabel("Verifier");
  registerAdvisorCheckWidget(pi);
  pi.registerTranscriptPresenter?.(presentLintAdvisor);
  let currentIntent;
  let currentSessionId;
  if (pi.registerTool) {
    const agentDir = pi.pi.getAgentDir();
    registerCloseoutTool(pi, (root, receipt) => verifyCloseoutReceipt(agentDir, root, receipt), async ctx => {
      const intent = currentIntent;
      if (intent?.waiver !== "verifier:resource-closeout" || ctx.sessionManager?.getSessionId() !== currentSessionId) {
        return false;
      }

      try {
        const { waiver } = await readRequestIntent(intent.handle);
        return intent === currentIntent && waiver === "verifier:resource-closeout";
      } catch {
        return false;
      }
    });
  }
  // Hide only the UI card; display:false also removes this metadata from advisor history.
  pi.registerMessageRenderer("verifier-work-intent", () => ({
    render: () => [],
    invalidate() {},
  }));
  await registerVerifierStatusReport(pi);
  await installGlobalVerifier({ agentDir: pi.pi.getAgentDir() });
  let confirmedWaiver;
  let openingWaiverAuthority;
  let sessionEpoch = 0;

  async function resetSessionAuthority() {
    const closingWaiverAuthority = openingWaiverAuthority;
    openingWaiverAuthority = undefined;
    confirmedWaiver = undefined;
    currentIntent = undefined;
    currentSessionId = undefined;
    sessionEpoch++;
    if (closingWaiverAuthority) {
      await closingWaiverAuthority.then(authority => authority.close(), () => undefined);
    }
  }

  pi.on("session_switch", resetSessionAuthority);
  pi.on("session_clear", resetSessionAuthority);
  pi.on("session_shutdown", resetSessionAuthority);

  pi.on("session_start", async (_event, ctx) => {
    const startedAt = performance.now();
    try {
      await installGlobalVerifier({ agentDir: ctx.agentDir || pi.pi.getAgentDir() });
    } catch (error) {
      ctx.ui.notify(`Verifier advisor setup failed: ${error.message}`, "warning");
    }
    logStartupTiming(pi, "session_start", startedAt);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (process.env.OMP_VERIFIER_FRESH_REVIEWER) {
      return {
        systemPrompt: [
          ...event.systemPrompt,
          "This is a checkpoint handoff. The primary must not use tools or assess source. Yield to the configured verifier; only it may inspect and evaluate the existing request. No new capture, waiver, edits or delivery are authorized here.",
        ],
      };
    }

    const startedAt = performance.now();
    const agentDir = ctx.agentDir || pi.pi.getAgentDir();
    const coordinatorPath = runtimePaths(agentDir).launcher;
    const COORDINATOR = `'${coordinatorPath.replaceAll("'", "'\"'\"'")}'`;
    let intent = { level: "normal", diagnostic: "No proven current request identity; using normal with no request handle." };
    try {
      const sessionId = ctx?.sessionManager?.getSessionId();
      if (event.reason === "prompt") {
        currentIntent = undefined;
        currentSessionId = undefined;
        if (sessionId) {
          const promptSessionEpoch = sessionEpoch;
          const activeWaiver = confirmedWaiver?.sessionId === sessionId ? confirmedWaiver : undefined;
          if (activeWaiver && activeWaiver.lifetime !== "--session") {
            confirmedWaiver = undefined;
          }

          const nextIntent = await createRequestIntent({
            sessionId,
            prompt: event.prompt,
            waiver: activeWaiver?.gate,
            waiverAuthorityId: activeWaiver?.authorityId,
          });
          if (promptSessionEpoch === sessionEpoch) {
            intent = nextIntent;
            currentIntent = intent;
            currentSessionId = sessionId;
          }
        }
      } else if (event.reason === "revive" && currentIntent && sessionId === currentSessionId) {
        intent = await readRequestIntent(currentIntent.handle);
      }
    } catch (error) {
      intent = { level: "normal", diagnostic: `Request intent unavailable; using normal with no exemption: ${error.message}` };
      currentIntent = undefined;
      currentSessionId = undefined;
    }
    let waiverGuidance = "No user-confirmed Verifier waiver applies to this request. Earlier waivers are not authority.";
    if (intent.waiver) {
      waiverGuidance = [
        `Verifier gate "${intent.waiver}" is waived by user for this request.`,
        "Do not dispatch or retry the selected gate or treat earlier results for that gate as outstanding for this operation.",
        "Preserve the evidence and report the waiver, never PASS.",
        "All other gates and external requirements still apply; the waiver is not merge approval.",
      ].join(" ");
    }

    const content = [
      intent.handle ? `${intent.level} --request ${intent.handle}` : "Verifier current request work level: normal; no request handle.",
      intent.handle
        ? `Request instance: ${intent.requestId}\nFor applicable PR/MR source review only: after confirming live eligibility, run node ${COORDINATOR} automatic --base <actual-PR-base> <current-edited-path...> --request '${intent.handle}' --progress in the owning checkout. Use ordinary Bash output (pty: false). Add --full for safety escalation, explicit verification/recheck, and initial delivery/release gates.`
        : "No request handle: use full selection without reuse only for an applicable review.",
      intent.diagnostic,
      "Work intent is not PASS and never overrides mandatory requirements, explicit verification, initial delivery/release checks, or semantic escalation. Earlier request handles are not authority for this request.",
      waiverGuidance,
    ].filter(Boolean).join("\n");
    const response = {
      message: { customType: "verifier-work-intent", content, display: true, attribution: "agent" },
      systemPrompt: [
        ...event.systemPrompt,
        "Before merging, enabling auto-merge, or enqueuing, confirm required verification finished for the open PR/MR's current target, base and head. If fresh named review is needed, leave it open and yield to the verifier before merge. Silence, a PENDING handle, and a prepared handoff are not passing results. Reconfirm the remote revisions and pin the verified head when merging.",
        "The verifier checks live GitHub/GitLab state immediately before starting, retrying or resuming automatic review. Do not dispatch if the PR/MR is no longer open at the intended revisions or the host cannot confirm them. Skipped is not PASS. A review-and-merge request is not a retrospective request; explicit retrospective checks and independent post-merge CI remain available.",
        "Verifier PENDING requests need the named reviewer's next command, not a file watcher. Hand still-applicable handles and their owning checkout back to the verifier for review --resume and assessment.",
        "Standalone status, cleanup, wrap-up and exit do not start verification or require a receipt. Follow ordinary cleanup safety checks and authorized project wrappers.",
        waiverGuidance,
        `Verifier delivery cleanup: before removing an edit-owning Git worktree with committed delivery changes awaiting final review, run node ${COORDINATOR} handoff prepare --base <actual-delivery-base> in its clean checkout. Preserve the returned handoffPath and source identity in the transcript before cleanup. Do not prepare an unrelated checkout or omit uncommitted changes; retain the original if preparation cannot complete. A handoff preserves source; it cannot postpone pre-merge verification. Leave it for the verifier to recover, check within its applicable scope, and release. Preparation, merge, and cleanup are not PASS. Missing runtime prerequisites remain BLOCKED. Only explicit user cancellation or waiver authorizes handoff cancel <handoffPath> --reason <reason>; cancellation is not verification.`,
      ],
    };
    logStartupTiming(pi, "before_agent_start", startedAt);
    return response;
  });

  pi.registerCommand("verifier", {
    description: "Show verifier setup, preview results, or run installed checks",
    getArgumentCompletions: completeSubcommands,
    handler: async (args, ctx) => {
      const [submittedAction, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const action = submittedAction ?? "status";
      const cwd = ctx.cwd || process.cwd();
      const agentDir = ctx.agentDir || pi.pi.getAgentDir();
      let invocationRecorded;
      if (ctx.hasUI) {
        invocationRecorded = await commandUsage.record(agentDir, submittedAction);
      }

      if (action === "status" && rest.length === 1 && rest[0] === "--usage") {
        const report = await commandUsage.report(agentDir, { invocationRecorded });
        return showVerifierStatusReport(pi, ctx, report);
      }

      if (action === "status") {
        const details = rest.length === 1 && rest[0] === "--details";
        if (rest.length && !details) {
          return ctx.ui.notify(`Usage: ${STATUS_USAGE}`, "error");
        }

        try {
          const status = await collectGlobalVerifierStatus(cwd, { agentDir });
          return showVerifierStatusReport(pi, ctx, formatVerifierStatus(status, { details }));
        } catch (error) {
          return ctx.ui.notify(`Verifier setup could not be read.\n${error.message}\nNext: Check access to WATCHDOG.yml and advisor guidance, then retry.`, "error");
        }
      }

      if (action === "uninstall" && rest.length === 0) {
        try {
          const changes = await uninstallGlobalVerifier({ agentDir });
          return ctx.ui.notify([
            "Verifier advisor cleanup completed.",
            ...changes,
            "Scope: The plugin remains installed; project setup was not changed.",
          ].join("\n"), "info");
        } catch (error) {
          return ctx.ui.notify(`Verifier advisor cleanup could not complete.\n${error.message}\nNext: Run /verifier status --details to inspect the remaining setup.`, "error");
        }
      }

      if (action === "checks" && rest.length === 0) {
        if (ctx.verificationPackageDirectory) {
          const inventory = await discoverVerificationChecks({
            packageDirectory: ctx.verificationPackageDirectory,
          });
          return ctx.ui.notify(formatSlashChecks(inventory), "info");
        }

        const result = await runtimeCommand(agentDir, cwd, ["checks", "--reporter", "json"]);
        return notifyRuntimeReport(ctx, result, formatSlashChecks);
      }

      if (action === "timings" && rest.length === 0) {
        const result = await runtimeCommand(agentDir, cwd, ["timings", "--reporter", "json"]);
        return notifyRuntimeReport(ctx, result, formatSlashTimings);
      }

      if (action === "demo" && rest.length === 0) {
        return showDemo(ctx);
      }

      if (action === "verify") {
        if (ctx.verificationPackageDirectory) {
          const output = await buildVerification(cwd, rest, ctx.verificationPackageDirectory);
          return ctx.ui.notify(verificationReport(output, rest), "info");
        }

        const result = await runtimeCommand(agentDir, cwd, ["verify", ...rest, "--reporter", "text"]);
        return ctx.ui.notify(verificationReport(result.output, rest), result.level);
      }

      if (action === "generation") {
        const result = await runtimeCommand(agentDir, cwd, ["generation", ...rest]);
        if (rest.includes("--help") || rest.includes("-h")) {
          return notifyRuntimeReport(ctx, result);
        }
        if (rest[0] === "activate" && result.level === "info") {
          try {
            await installGlobalVerifier({ agentDir });
          } catch (error) {
            return ctx.ui.notify(`Verifier generation activated, but advisor setup could not be refreshed.\n${error.message}\nNext: Start a fresh OMP session to refresh the managed setup.`, "warning");
          }
        }

        return notifyRuntimeReport(ctx, result, output => formatSlashGeneration(rest[0], output));
      }

      if (action === "closeout") {
        if (rest[0] === "prepare" && !rest.includes("--help") && !rest.includes("-h")) {
          const result = await runtimeCommand(agentDir, cwd, ["closeout", ...rest, "--reporter", "json"]);
          return notifyRuntimeReport(ctx, result, output => {
            if (output.status === "PREPARED") {
              return formatSlashCloseoutReceipt(output);
            }
            return formatVerificationResults(output);
          });
        }

        const result = await runtimeCommand(agentDir, cwd, ["closeout", ...rest, "--reporter", "text"]);
        return ctx.ui.notify(verificationReport(result.output, rest), result.level);
      }

      if (action === "waive") {
        const [gate, lifetime, ...unexpected] = rest;
        if (!isRequestWaiver(gate) || (lifetime !== undefined && lifetime !== "--session") || unexpected.length > 0) {
          return ctx.ui.notify(`Usage: ${WAIVER_USAGE}`, "error");
        }

        const sessionId = ctx.sessionManager?.getSessionId();
        if (!sessionId || !ctx.hasUI || typeof ctx.ui.confirm !== "function") {
          return ctx.ui.notify("Verifier waiver not granted.\nIt requires user confirmation in the active session UI.", "warning");
        }

        const confirmationSessionEpoch = sessionEpoch;
        const scope = lifetime === "--session" ? "each prompt in this live session" : "the next prompt in this session";
        const confirmed = await ctx.ui.confirm(
          "Waive a Verifier gate?",
          `Waive "${gate}" for ${scope}? This replaces any already armed Verifier waiver. It is not PASS, merge approval, or permission to bypass external requirements.`,
        );
        if (confirmed !== true) {
          return ctx.ui.notify("Verifier waiver not granted.", "info");
        }

        if (confirmationSessionEpoch !== sessionEpoch || ctx.sessionManager.getSessionId() !== sessionId) {
          return ctx.ui.notify("Verifier waiver not granted because the active session changed.", "warning");
        }

        const openingAuthority = openingWaiverAuthority ??= openRequestWaiverAuthority();
        let authorityId;
        try {
          const { id } = await openingAuthority;
          authorityId = id;
        } catch (error) {
          if (openingWaiverAuthority === openingAuthority) {
            openingWaiverAuthority = undefined;
          }

          return ctx.ui.notify(`Verifier waiver not granted: ${error.message}`, "warning");
        }

        if (confirmationSessionEpoch !== sessionEpoch || ctx.sessionManager.getSessionId() !== sessionId) {
          return ctx.ui.notify("Verifier waiver not granted because the active session changed.", "warning");
        }

        confirmedWaiver = {
          sessionId,
          gate,
          lifetime,
          authorityId,
        };
        return ctx.ui.notify([
          `Verifier waiver confirmed for "${gate}".`,
          `Applies to: ${scope}.`,
          "This is not PASS or merge approval; other requirements still apply.",
        ].join("\n"), "info");
      }

      return ctx.ui.notify(`Usage: ${COMMAND_USAGE}\nType /verifier followed by a space to see available commands.`, "error");
    },
  });
  logStartupTiming(pi, "extension_load", loadStartedAt);
}

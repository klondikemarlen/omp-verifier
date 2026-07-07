import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";


const ADVISOR_CONFIG = `advisor:
  enabled: true
  subagents: true
  syncBacklog: 1
`;

const WATCHDOG_ROSTER = `instructions: |
  Everyone: keep advice concrete, evidence-first, and non-repetitive.

advisors:
  - name: Verifier
    tools: [read, grep, glob]
    instructions: |
      @~/.omp/plugins/node_modules/omp-verifier/WATCHDOG.md

      You are the always-on verifier for this project.
      Review completed code-change turns as untrusted until evidence proves them.
      Raise a blocker when work is called done without observed evidence.
      Raise a concern when checks are too broad, too narrow, or ignore local setup.
      Stay silent when the evidence is sufficient.

      Downstream project rules belong below this import: setup commands, test commands,
      database/service details, browser routes, and project-specific "done means" checks.
`;

async function writeBootstrapFile(path, content, force, forceHint = true) {
  try {
    await writeFile(path, content, { flag: force ? "w" : "wx" });
    return `${force ? "replaced" : "created"} ${path}`;
  } catch (error) {
    if (error?.code === "EEXIST") return `kept existing ${path}${forceHint ? " (rerun with --force to replace)" : " (merge advisor keys manually)"}`;
    throw error;
  }
}

export default function verifierPlugin(pi) {

  pi.setLabel("Verifier");

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Verifier plugin loaded", "info");
  });

  pi.registerCommand("verifier-info", {
    description: "Show verifier advisor bootstrap command",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Verifier: /verifier-bootstrap [--force] scaffolds project-local OMP advisor setup.",
        "info",
      );
    },
  });

  pi.registerCommand("verifier-bootstrap", {
    description: "Bootstrap this repo to use omp-verifier as an always-on advisor",
    handler: async (args, ctx) => {
      const force = args.trim().split(/\s+/).includes("--force");
      const cwd = ctx.cwd || process.cwd();
      const configDir = join(cwd, ".omp");
      await mkdir(configDir, { recursive: true });

      const results = [
        await writeBootstrapFile(join(configDir, "config.yml"), ADVISOR_CONFIG, false, false),
        await writeBootstrapFile(join(cwd, "WATCHDOG.yml"), WATCHDOG_ROSTER, force),
      ];

      ctx.ui.notify(`${results.join("; ")}. Restart OMP from this repo or run /advisor on.`, "info");
    },
  });

}

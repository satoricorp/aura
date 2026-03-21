import path from "node:path";
import * as p from "@clack/prompts";
import { writeTextIfMissing } from "../../core/utils/fs";
import { resolveProjectPaths } from "../../core/utils/paths";

const DEFAULT_AURA_MD = `# Aura Agents

## Example Agent
Describe the job this agent should do in plain language.
`;

const DEFAULT_AURA_CONFIG = `import { config } from "aura";

export default config({
  model: {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
  },
  outDir: "dist",
  maxSteps: 5,
});
`;

export interface InitResult {
  created: string[];
  skipped: string[];
}

/**
 * Creates Aura's starter files without overwriting user-owned content.
 *
 * This command is intentionally idempotent so users can rerun `aura init`
 * safely in an existing project and only fill in files that are still missing.
 */
export async function scaffoldAuraProject(cwd = process.cwd()): Promise<InitResult> {
  const { auraFile, configFile } = resolveProjectPaths(cwd);
  const created: string[] = [];
  const skipped: string[] = [];

  if (await writeTextIfMissing(configFile, DEFAULT_AURA_CONFIG)) {
    created.push(configFile);
  } else {
    skipped.push(configFile);
  }

  if (await writeTextIfMissing(auraFile, DEFAULT_AURA_MD)) {
    created.push(auraFile);
  } else {
    skipped.push(auraFile);
  }

  return { created, skipped };
}

export async function runInit(cwd = process.cwd()): Promise<void> {
  const result = await scaffoldAuraProject(cwd);

  for (const filePath of result.created) {
    p.log.success(`Created ${path.basename(filePath)}`);
  }

  for (const filePath of result.skipped) {
    p.log.warn(`${path.basename(filePath)} already exists`);
  }

  p.note("Edit aura.md to describe your agents, then run:\naura generate", "Next");
}

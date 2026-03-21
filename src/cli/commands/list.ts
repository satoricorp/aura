import { loadAuraMarkdown } from "../../core/aura-md";
import { pathExists } from "../../core/utils/fs";
import { resolveProjectPaths } from "../../core/utils/paths";
import { formatAgentList } from "../utils/format";

export async function listAgents(cwd = process.cwd()): Promise<string> {
  const { auraFile } = resolveProjectPaths(cwd);
  if (!(await pathExists(auraFile))) {
    throw new Error("aura.md not found. Run `aura init` first.");
  }

  const document = await loadAuraMarkdown(cwd);
  return formatAgentList(document);
}

export async function runList(cwd = process.cwd()): Promise<void> {
  console.log(await listAgents(cwd));
}

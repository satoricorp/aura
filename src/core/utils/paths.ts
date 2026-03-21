import path from "node:path";

export const AURA_MD_FILE = "aura.md";
export const AURA_CONFIG_FILE = "aura.config.ts";

export interface ProjectPaths {
  cwd: string;
  auraFile: string;
  configFile: string;
  agentsDir: string;
  distDir: string;
}

export function resolveProjectPaths(cwd = process.cwd()): ProjectPaths {
  return {
    cwd,
    auraFile: path.join(cwd, AURA_MD_FILE),
    configFile: path.join(cwd, AURA_CONFIG_FILE),
    agentsDir: path.join(cwd, "src", "agents"),
    distDir: path.join(cwd, "dist"),
  };
}

import { pathToFileURL } from "node:url";
import { pathExists } from "./utils/fs";
import { resolveProjectPaths } from "./utils/paths";

export type ModelProvider = "anthropic" | "openai";

export interface AuraModelConfig {
  provider: ModelProvider;
  model: string;
}

export interface AuraConfig {
  model: AuraModelConfig;
  outDir: string;
  maxSteps: number;
}

export interface AuraConfigInput {
  model?: Partial<AuraModelConfig>;
  outDir?: string;
  maxSteps?: number;
}

export interface LoadedConfig {
  config: AuraConfig;
  exists: boolean;
  path: string;
}

export const DEFAULT_CONFIG = Object.freeze({
  model: {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
  },
  outDir: "dist",
  maxSteps: 5,
} as const) as AuraConfig;

export function createConfig(input: AuraConfigInput = {}): AuraConfig {
  return {
    model: {
      provider: input.model?.provider ?? DEFAULT_CONFIG.model.provider,
      model: input.model?.model ?? DEFAULT_CONFIG.model.model,
    },
    outDir: input.outDir ?? DEFAULT_CONFIG.outDir,
    maxSteps: input.maxSteps ?? DEFAULT_CONFIG.maxSteps,
  };
}

export const config = createConfig;

export async function loadConfig(cwd = process.cwd()): Promise<LoadedConfig> {
  const { configFile } = resolveProjectPaths(cwd);
  if (!(await pathExists(configFile))) {
    return {
      config: createConfig(),
      exists: false,
      path: configFile,
    };
  }

  const imported = await import(`${pathToFileURL(configFile).href}?t=${Date.now()}`);
  const loaded = isConfigInput(imported.default) ? imported.default : {};

  return {
    config: createConfig(loaded),
    exists: true,
    path: configFile,
  };
}

function isConfigInput(value: unknown): value is AuraConfigInput {
  return typeof value === "object" && value !== null;
}

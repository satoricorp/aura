import * as p from "@clack/prompts";
import {
  ALL_SURFACES,
  buildGeneratedBundles,
  createInPlaceValidationRunner,
  ensureManagedBlocks,
  parseGenerateOptions,
  prepareAgentsFromManagedBlocks,
  resolveGenerateTargets,
  updateExaCredential,
  validateGeneratedBundles,
  writeGeneratedBundles,
  type AgentSummary,
  type GenerateOptions,
  type GeneratedAgentBundle,
  type ValidationRunner,
} from "../../core/generate";
import { loadAuraMarkdown, parseAuraMarkdown, upsertManagedBlocks } from "../../core/aura-md";
import { loadConfig } from "../../core/config";
import { createModelClient } from "../../core/model-client";
import { parseAnnotation, serializeAnnotation, type SurfaceName } from "../../core/agent-schema";
import { pathExists, readText, writeText } from "../../core/utils/fs";
import { resolveProjectPaths } from "../../core/utils/paths";

export interface GeneratePromptAdapter {
  confirm(message: string, initialValue?: boolean): Promise<boolean>;
  multiselectSurfaces(initialValues: SurfaceName[]): Promise<SurfaceName[]>;
  input(message: string, initialValue?: string): Promise<string>;
  pause(message: string): Promise<void>;
  logSuccess(message: string): void;
  logWarn(message: string): void;
  note(message: string, title?: string): void;
  info(message: string): void;
}

export interface GenerateCommandDeps {
  prompts?: GeneratePromptAdapter;
  modelClientFactory?: typeof createModelClient;
  validationRunnerFactory?: (cwd: string) => ValidationRunner;
}

export async function runGenerate(
  args: string[] = [],
  cwd = process.cwd(),
  deps: GenerateCommandDeps = {},
): Promise<void> {
  const options = parseGenerateOptions(args);
  const { auraFile } = resolveProjectPaths(cwd);
  if (!(await pathExists(auraFile))) {
    throw new Error("aura.md not found. Run `aura init` first.");
  }

  const prompts = deps.prompts ?? createClackPromptAdapter();
  const configResult = await loadConfig(cwd);
  const modelClient = (deps.modelClientFactory ?? createModelClient)(configResult.config);
  const initialDocument = await loadAuraMarkdown(cwd);
  const targets = resolveGenerateTargets(initialDocument, options);

  if (!configResult.exists) {
    prompts.logWarn("aura.config.ts not found. Using default Aura config values.");
  }

  const managed = await ensureManagedBlocks(
    initialDocument,
    targets,
    configResult.config,
    modelClient,
  );

  let currentDocument = managed.document;

  if (!options.dryRun && currentDocument.raw !== initialDocument.raw) {
    await writeText(auraFile, currentDocument.raw);
    prompts.logSuccess("Updated aura.md with generated annotation and metadata blocks.");
  }

  logExtractionSummaries(
    managed.preparedAgents.map((agent) => agent.root.annotation),
    prompts,
  );

  if (managed.extractedSections.length > 0) {
    currentDocument = await handleExaApprovals(
      cwd,
      currentDocument,
      managed.extractedSections.map((section) => section.section.slug),
      prompts,
    );

    if (!options.dryRun && currentDocument.raw !== managed.document.raw) {
      await writeText(auraFile, currentDocument.raw);
    }
  }

  const selectedSurfaces = await resolveSelectedSurfaces(options, prompts);

  if (options.dryRun) {
    const bundles = await buildGeneratedBundles(
      cwd,
      managed.preparedAgents.map((agent) => ({
        ...agent,
        root: {
          ...agent.root,
          annotation: currentDocument.sections.find(
            (section) => section.slug === agent.root.section.slug,
          )?.annotation
            ? parseAnnotation(
                currentDocument.sections.find(
                  (section) => section.slug === agent.root.section.slug,
                )!.annotation!.value,
              )
            : agent.root.annotation,
        },
      })),
      configResult.config,
      selectedSurfaces,
      modelClient,
    );
    logBundlePlan(bundles, prompts);
    prompts.note("Dry run complete. No files were written.", "Generate");
    return;
  }

  prompts.note(
    "Review and edit aura.md if you want to refine the generated annotations, then press Enter to continue.",
    "Checkpoint",
  );
  await prompts.pause("Press Enter to continue");

  const reloadedDocument = parseAuraMarkdown(await readText(auraFile));
  const reloadedTargets = resolveGenerateTargets(reloadedDocument, options);
  const preparedAgents = prepareAgentsFromManagedBlocks(reloadedDocument, reloadedTargets);
  const bundles = await buildGeneratedBundles(
    cwd,
    preparedAgents,
    configResult.config,
    selectedSurfaces,
    modelClient,
  );

  logBundlePlan(bundles, prompts);
  const shouldWrite = await prompts.confirm("Generate these files?", true);
  if (!shouldWrite) {
    prompts.logWarn("Generation cancelled.");
    return;
  }

  await writeGeneratedBundles(bundles, selectedSurfaces);
  prompts.logSuccess("Generated source files under src/agents.");

  const validationRunner = (deps.validationRunnerFactory ?? createInPlaceValidationRunner)(cwd);
  await validateGeneratedBundles(bundles, validationRunner);
  prompts.logSuccess("Validated generated surfaces with per-surface TypeScript build checks.");
}

function createClackPromptAdapter(): GeneratePromptAdapter {
  return {
    async confirm(message: string, initialValue = true): Promise<boolean> {
      const result = await p.confirm({
        message,
        initialValue,
      });
      return unwrapPromptResult(result);
    },
    async multiselectSurfaces(initialValues: SurfaceName[]): Promise<SurfaceName[]> {
      const result = await p.multiselect({
        message: "Which surfaces do you want to generate?",
        initialValues,
        options: ALL_SURFACES.map((surface) => ({
          label: surface.toUpperCase(),
          value: surface,
        })),
      });

      const values = unwrapPromptResult(result) as SurfaceName[];
      if (values.length === 0) {
        throw new Error("Select at least one surface to generate.");
      }

      return values;
    },
    async input(message: string, initialValue = ""): Promise<string> {
      const result = await p.text({
        message,
        defaultValue: initialValue,
      });
      return String(unwrapPromptResult(result));
    },
    async pause(message: string): Promise<void> {
      await p.text({
        message,
        defaultValue: "",
      });
    },
    logSuccess(message: string): void {
      p.log.success(message);
    },
    logWarn(message: string): void {
      p.log.warn(message);
    },
    note(message: string, title?: string): void {
      p.note(message, title);
    },
    info(message: string): void {
      console.log(message);
    },
  };
}

async function resolveSelectedSurfaces(
  options: GenerateOptions,
  prompts: GeneratePromptAdapter,
): Promise<SurfaceName[]> {
  if (options.surface) {
    return [options.surface];
  }

  return prompts.multiselectSurfaces([...ALL_SURFACES]);
}

async function handleExaApprovals(
  cwd: string,
  document: ReturnType<typeof parseAuraMarkdown>,
  sectionSlugs: string[],
  prompts: GeneratePromptAdapter,
): Promise<ReturnType<typeof parseAuraMarkdown>> {
  let currentDocument = document;
  let approved = false;

  for (const slug of sectionSlugs) {
    const section = currentDocument.sections.find((entry) => entry.slug === slug);
    if (!section?.annotation) {
      continue;
    }

    const annotation = parseAnnotation(section.annotation.value);
    if (!annotation.tools.some((tool) => tool.id === "exa_search")) {
      continue;
    }

    const include = await prompts.confirm(
      `${section.title} proposes web search (exa_search). Include it?`,
      true,
    );

    if (include) {
      approved = true;
      continue;
    }

    annotation.tools = annotation.tools.filter((tool) => tool.id !== "exa_search");
    currentDocument = parseAuraMarkdown(
      upsertManagedBlocks(currentDocument, section.slug, {
        annotation: serializeAnnotation(annotation),
      }),
    );
  }

  if (!approved) {
    return currentDocument;
  }

  const apiKey = await prompts.input("EXA_API_KEY (optional, leave blank to skip)");
  const result = await updateExaCredential(cwd, apiKey);
  if (result === "updated") {
    prompts.logSuccess("Updated .env with EXA_API_KEY.");
  } else if (result === "missing-env") {
    prompts.logWarn("No .env file found. Add EXA_API_KEY to your environment manually.");
  }

  return currentDocument;
}

function logExtractionSummaries(
  annotations: Array<{
    id: string;
    tools: Array<{ id: string }>;
    endpoints: Array<{ method: string; path: string }>;
    subagents: string[];
  }>,
  prompts: GeneratePromptAdapter,
): void {
  for (const annotation of annotations) {
    prompts.info(
      [
        `  ${annotation.id}`,
        `    - ${annotation.endpoints.length} endpoints`,
        `    - ${annotation.tools.length} tools`,
        `    - ${annotation.subagents.length} subagents`,
      ].join("\n"),
    );
  }
}

function logBundlePlan(bundles: GeneratedAgentBundle[], prompts: GeneratePromptAdapter): void {
  for (const bundle of bundles) {
    if (bundle.overwrite) {
      prompts.logWarn(
        `src/agents/${bundle.agent.root.annotation.id}/ already exists and targeted files will be overwritten.`,
      );
    }

    prompts.info(formatBundleSummary(bundle.summary, bundle.files.length));
    for (const warning of bundle.warnings) {
      prompts.logWarn(`${bundle.agent.root.annotation.id}: ${warning}`);
    }
  }
}

function formatBundleSummary(summary: AgentSummary, fileCount: number): string {
  return [
    `  ${summary.id}`,
    `    ${summary.endpoints} endpoints · ${summary.tools} tools · ${summary.subagents} subagents`,
    `    [${summary.surfaces.join(", ").toUpperCase()}]`,
    `    ${fileCount} files`,
  ].join("\n");
}

function unwrapPromptResult<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    throw new Error("Cancelled.");
  }

  return value;
}

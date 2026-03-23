import path from "node:path";
import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  type AgentAnnotation,
  type AgentMetadata,
  type EndpointSpec,
  type SurfaceName,
  type ToolSpec,
  isSurfaceName,
  parseAnnotation,
  parseMetadata,
  serializeAnnotation,
  serializeMetadata,
} from "./agent-schema";
import {
  type AuraDocument,
  type AuraSection,
  getChildSections,
  getRootSections,
  parseAuraMarkdown,
  summarizeAnnotation,
  upsertManagedBlocks,
} from "./aura-md";
import type { AuraConfig } from "./config";
import type { ModelClient } from "./model-client";
import { normalizeAgentName, toSlug } from "./slugs";
import { pathExists, readText, writeText } from "./utils/fs";
import { resolveProjectPaths } from "./utils/paths";

export interface GenerateOptions {
  agent?: string;
  surface?: SurfaceName;
  dryRun: boolean;
}

export interface GenerateTarget {
  root: AuraSection;
  sections: AuraSection[];
}

export interface PreparedSection {
  section: AuraSection;
  annotation: AgentAnnotation;
  metadata: AgentMetadata;
  extracted: boolean;
  metadataCreated: boolean;
}

export interface PreparedAgent {
  root: PreparedSection;
  descendants: PreparedSection[];
}

export interface GeneratedFile {
  path: string;
  contents: string;
  kind: "shared" | SurfaceName;
}

export interface GeneratedAgentBundle {
  agent: PreparedAgent;
  surfaces: SurfaceName[];
  files: GeneratedFile[];
  overwrite: boolean;
  summary: AgentSummary;
  warnings: string[];
}

export interface AgentSummary {
  id: string;
  tools: number;
  endpoints: number;
  subagents: number;
  surfaces: SurfaceName[];
}

export interface CustomLogicDraft {
  tools: Record<string, string>;
  endpoints: Record<string, string>;
}

export interface ValidationRunner {
  validate(agentId: string, surface: SurfaceName, surfaceDir: string): Promise<void>;
}

interface ExtractionResponse {
  systemPrompt?: string;
  tools?: Array<{
    id?: string;
    description?: string;
    requiresCredential?: string;
  }>;
  endpoints?: Array<{
    method?: string;
    path?: string;
    description?: string;
    streaming?: boolean;
  }>;
}

interface CustomLogicResponse {
  tools?: Array<{
    id?: string;
    executeBody?: string;
  }>;
  endpoints?: Array<{
    path?: string;
    handlerBody?: string;
  }>;
}

const ALL_SURFACES: SurfaceName[] = ["api", "mcp", "cli", "skill"];

export function parseGenerateOptions(args: string[]): GenerateOptions {
  const dryRun = args.includes("--dry-run");
  const positionals = args.filter((value) => value !== "--dry-run");

  if (positionals.length > 2) {
    throw new Error(
      "Usage: aura generate [agent] [surface] [--dry-run]\n\nSupported surfaces: api, mcp, cli, skill",
    );
  }

  const [agent, surface] = positionals;
  if (surface && !isSurfaceName(surface)) {
    throw new Error(`Unknown surface "${surface}". Expected one of: api, mcp, cli, skill.`);
  }

  return {
    agent,
    surface: surface as SurfaceName | undefined,
    dryRun,
  };
}

export function resolveGenerateTargets(
  document: AuraDocument,
  options: GenerateOptions,
): GenerateTarget[] {
  const roots = getRootSections(document);
  if (roots.length === 0) {
    throw new Error("No agents found in aura.md.");
  }

  if (!options.agent) {
    return roots.map((root) => ({
      root,
      sections: collectOwnedSections(document, root),
    }));
  }

  const normalizedTarget = normalizeAgentName(options.agent);
  const match = roots.find((root) => {
    return (
      normalizeAgentName(root.slug) === normalizedTarget ||
      normalizeAgentName(root.title) === normalizedTarget
    );
  });

  if (!match) {
    const available = roots.map((root) => `  ${root.slug}`).join("\n");
    throw new Error(`No agent "${options.agent}" found.\n\nAvailable agents:\n${available}`);
  }

  return [
    {
      root: match,
      sections: collectOwnedSections(document, match),
    },
  ];
}

export async function ensureManagedBlocks(
  document: AuraDocument,
  targets: GenerateTarget[],
  config: AuraConfig,
  modelClient: ModelClient,
): Promise<{
  document: AuraDocument;
  preparedAgents: PreparedAgent[];
  extractedSections: PreparedSection[];
}> {
  let currentDocument = document;
  const extractedSections: PreparedSection[] = [];
  const preparedBySlug = new Map<string, PreparedSection>();

  for (const target of targets) {
    for (const originalSection of target.sections) {
      const section = findSection(currentDocument, originalSection.slug);
      const directChildren = getChildSections(currentDocument, section.slug);

      const annotation =
        section.annotation !== undefined
          ? parseAnnotation(section.annotation.value)
          : await extractSectionAnnotation(section, directChildren, modelClient);
      annotation.id = annotation.id || section.slug;
      annotation.description = annotation.description || section.description || section.title;
      annotation.subagents = directChildren.map((child) => child.slug);

      const metadata =
        section.metadata !== undefined
          ? parseMetadata(section.metadata.value)
          : {
              model: config.model.model,
            };

      const prepared: PreparedSection = {
        section,
        annotation,
        metadata,
        extracted: section.annotation === undefined,
        metadataCreated: section.metadata === undefined,
      };

      if (prepared.extracted || prepared.metadataCreated) {
        const nextRaw = upsertManagedBlocks(currentDocument, section.slug, {
          annotation: serializeAnnotation(annotation),
          metadata: serializeMetadata(metadata),
        });
        currentDocument = parseAuraMarkdown(nextRaw);
      }

      const refreshed = findSection(currentDocument, section.slug);
      const stablePrepared: PreparedSection = {
        ...prepared,
        section: refreshed,
      };

      preparedBySlug.set(section.slug, stablePrepared);
      if (stablePrepared.extracted) {
        extractedSections.push(stablePrepared);
      }
    }
  }

  return {
    document: currentDocument,
    preparedAgents: targets.map((target) => buildPreparedAgent(target.root.slug, preparedBySlug)),
    extractedSections,
  };
}

export function prepareAgentsFromManagedBlocks(
  document: AuraDocument,
  targets: GenerateTarget[],
): PreparedAgent[] {
  const preparedBySlug = new Map<string, PreparedSection>();

  for (const target of targets) {
    for (const section of target.sections) {
      const refreshed = findSection(document, section.slug);
      if (!refreshed.annotation) {
        throw new Error(`Section "${refreshed.title}" is missing an annotation block.`);
      }

      if (!refreshed.metadata) {
        throw new Error(`Section "${refreshed.title}" is missing a metadata block.`);
      }

      preparedBySlug.set(refreshed.slug, {
        section: refreshed,
        annotation: parseAnnotation(refreshed.annotation.value),
        metadata: parseMetadata(refreshed.metadata.value),
        extracted: false,
        metadataCreated: false,
      });
    }
  }

  return targets.map((target) => buildPreparedAgent(target.root.slug, preparedBySlug));
}

export async function draftCustomLogic(
  agent: PreparedAgent,
  modelClient: ModelClient,
): Promise<CustomLogicDraft> {
  const customTools = agent.root.annotation.tools.filter((tool) => !isBuiltInTool(tool.id));
  const customEndpoints = agent.root.annotation.endpoints.filter(
    (endpoint) => !isChatEndpoint(endpoint),
  );

  if (customTools.length === 0 && customEndpoints.length === 0) {
    return {
      tools: {},
      endpoints: {},
    };
  }

  try {
    const response = await modelClient.generateJson<CustomLogicResponse>({
      system:
        "You draft Aura TypeScript stub bodies. Return only JSON with compilable TypeScript snippets. " +
        "Use only the variables documented in the prompt. Do not include imports, markdown, or prose.",
      prompt: buildCustomLogicPrompt(agent, customTools, customEndpoints),
    });

    return {
      tools: Object.fromEntries(
        customTools.map((tool) => [
          tool.id,
          response.tools?.find((entry) => entry.id === tool.id)?.executeBody?.trim() ||
            defaultToolBody(tool),
        ]),
      ),
      endpoints: Object.fromEntries(
        customEndpoints.map((endpoint) => [
          endpoint.path,
          response.endpoints?.find((entry) => entry.path === endpoint.path)?.handlerBody?.trim() ||
            defaultEndpointBody(endpoint),
        ]),
      ),
    };
  } catch {
    return {
      tools: Object.fromEntries(customTools.map((tool) => [tool.id, defaultToolBody(tool)])),
      endpoints: Object.fromEntries(
        customEndpoints.map((endpoint) => [endpoint.path, defaultEndpointBody(endpoint)]),
      ),
    };
  }
}

export async function buildGeneratedBundles(
  cwd: string,
  agents: PreparedAgent[],
  config: AuraConfig,
  surfaces: SurfaceName[],
  modelClient: ModelClient,
): Promise<GeneratedAgentBundle[]> {
  return Promise.all(
    agents.map(async (agent) => {
      const warnings = collectAgentWarnings(agent);
      const customLogic = await draftCustomLogic(agent, modelClient);
      const files = renderAgentFiles(cwd, agent, config, surfaces, customLogic);
      const agentDir = path.join(resolveProjectPaths(cwd).agentsDir, agent.root.annotation.id);

      return {
        agent,
        surfaces,
        files,
        overwrite: await pathExists(agentDir),
        summary: summarizeAgent(agent, surfaces),
        warnings,
      };
    }),
  );
}

export async function writeGeneratedBundles(
  bundles: GeneratedAgentBundle[],
  surfaces: SurfaceName[],
): Promise<void> {
  for (const bundle of bundles) {
    await clearGeneratedOutputs(bundle, surfaces);
    for (const file of bundle.files) {
      await writeText(file.path, file.contents);
    }
  }
}

export async function validateGeneratedBundles(
  bundles: GeneratedAgentBundle[],
  runner: ValidationRunner,
): Promise<void> {
  for (const bundle of bundles) {
    for (const surface of bundle.surfaces) {
      if (surface === "skill") {
        continue;
      }

      const surfaceFile = bundle.files.find((file) => file.kind === surface);
      if (!surfaceFile) {
        throw new Error(
          `Missing generated ${surface} file for agent "${bundle.agent.root.annotation.id}".`,
        );
      }

      const surfaceDir = path.dirname(surfaceFile.path);
      await runner.validate(bundle.agent.root.annotation.id, surface, surfaceDir);
    }
  }
}

export async function updateExaCredential(
  cwd: string,
  apiKey: string,
): Promise<"updated" | "missing-env" | "skipped"> {
  if (!apiKey.trim()) {
    return "skipped";
  }

  const envPath = path.join(cwd, ".env");
  if (!(await pathExists(envPath))) {
    return "missing-env";
  }

  const raw = await readText(envPath);
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const nextLines: string[] = [];
  let replaced = false;

  for (const line of lines) {
    if (line.startsWith("EXA_API_KEY=")) {
      nextLines.push(`EXA_API_KEY=${apiKey}`);
      replaced = true;
      continue;
    }

    nextLines.push(line);
  }

  if (!replaced) {
    if (nextLines.length > 0 && nextLines.at(-1)?.trim() !== "") {
      nextLines.push("");
    }
    nextLines.push(`EXA_API_KEY=${apiKey}`);
  }

  await writeText(envPath, `${nextLines.join("\n").trimEnd()}\n`);
  return "updated";
}

export function createInPlaceValidationRunner(cwd: string): ValidationRunner {
  const packageManager = detectPackageManager(cwd);

  return {
    async validate(agentId: string, surface: SurfaceName, surfaceDir: string): Promise<void> {
      if (!(await pathExists(surfaceDir))) {
        throw new Error(`Cannot validate ${agentId}/${surface}: ${surfaceDir} does not exist.`);
      }

      try {
        const installCommand = getInstallCommand(packageManager);
        await runCommand(surfaceDir, installCommand.command, installCommand.args);
        const buildCommand = getRunScriptCommand(packageManager, "build");
        await runCommand(surfaceDir, buildCommand.command, buildCommand.args);
      } catch (error) {
        const prefix = `Validation failed for ${agentId}/${surface}.`;
        if (error instanceof Error) {
          throw new Error(`${prefix}\n\n${error.message}`);
        }

        throw new Error(`${prefix}\n\n${String(error)}`);
      } finally {
        await cleanupValidationArtifacts(surfaceDir);
      }
    },
  };
}

function collectOwnedSections(document: AuraDocument, root: AuraSection): AuraSection[] {
  const result: AuraSection[] = [root];

  for (const child of getChildSections(document, root.slug)) {
    result.push(...collectOwnedSections(document, child));
  }

  return result;
}

function buildPreparedAgent(
  rootSlug: string,
  preparedBySlug: Map<string, PreparedSection>,
): PreparedAgent {
  const root = preparedBySlug.get(rootSlug);
  if (!root) {
    throw new Error(`Unknown prepared root "${rootSlug}".`);
  }

  const descendants = [...preparedBySlug.values()].filter(
    (entry) => entry.section.parentSlug !== undefined,
  );
  const ownedDescendants = descendants.filter((entry) =>
    isOwnedBy(entry.section, root.section.slug, preparedBySlug),
  );

  return {
    root,
    descendants: ownedDescendants,
  };
}

function isOwnedBy(
  section: AuraSection,
  ancestorSlug: string,
  preparedBySlug: Map<string, PreparedSection>,
): boolean {
  let parentSlug = section.parentSlug;

  while (parentSlug) {
    if (parentSlug === ancestorSlug) {
      return true;
    }

    parentSlug = preparedBySlug.get(parentSlug)?.section.parentSlug;
  }

  return false;
}

function findSection(document: AuraDocument, slug: string): AuraSection {
  const match = document.sections.find((section) => section.slug === slug);
  if (!match) {
    throw new Error(`Unknown section "${slug}".`);
  }

  return match;
}

async function extractSectionAnnotation(
  section: AuraSection,
  directChildren: AuraSection[],
  modelClient: ModelClient,
): Promise<AgentAnnotation> {
  const response = await modelClient.generateJson<ExtractionResponse>({
    system:
      "You convert Aura markdown sections into structured agent annotations. Return only JSON. " +
      "Keep tools and endpoints concise, practical, and compilable.",
    prompt: buildExtractionPrompt(section, directChildren),
  });

  return {
    id: section.slug,
    description: section.description || section.title,
    systemPrompt: response.systemPrompt?.trim() || section.description || section.title,
    tools: normalizeTools(response.tools),
    endpoints: normalizeEndpoints(response.endpoints, section.level),
    subagents: directChildren.map((child) => child.slug),
  };
}

function normalizeTools(value: ExtractionResponse["tools"]): ToolSpec[] {
  const tools: ToolSpec[] = [];

  for (const tool of value ?? []) {
    const id = tool.id ? toSlug(tool.id) : "";
    const description = tool.description?.trim() ?? "";
    if (!id || !description) {
      continue;
    }

    tools.push({
      id,
      description,
      requiresCredential: tool.requiresCredential?.trim() || undefined,
    });
  }

  return tools;
}

function normalizeEndpoints(value: ExtractionResponse["endpoints"], level: number): EndpointSpec[] {
  if (level > 2) {
    return [];
  }

  const endpoints: EndpointSpec[] = [];

  for (const endpoint of value ?? []) {
    const method = endpoint.method?.trim().toUpperCase() || "";
    const routePath = endpoint.path?.trim() || "";
    const description = endpoint.description?.trim() || "";
    if (!method || !routePath || !description) {
      continue;
    }

    endpoints.push({
      method,
      path: routePath.startsWith("/") ? routePath : `/${routePath}`,
      description,
      streaming: endpoint.streaming,
    });
  }

  return endpoints;
}

function buildExtractionPrompt(section: AuraSection, directChildren: AuraSection[]): string {
  return JSON.stringify(
    {
      section: {
        title: section.title,
        slug: section.slug,
        level: section.level,
        description: section.description,
      },
      children: directChildren.map((child) => ({
        title: child.title,
        slug: child.slug,
        description: child.description,
      })),
      schema: {
        systemPrompt: "string",
        tools: [
          {
            id: "string",
            description: "string",
            requiresCredential: "optional string",
          },
        ],
        endpoints: [
          {
            method: "HTTP verb",
            path: "absolute path beginning with /",
            description: "string",
            streaming: "optional boolean",
          },
        ],
      },
      rules: [
        "Return valid JSON only.",
        "Use exa_search only when web search is genuinely useful.",
        "Prefer a POST /chat endpoint when the section is conversational and level is 2.",
        "Subagents never expose endpoints in this response.",
      ],
    },
    null,
    2,
  );
}

function buildCustomLogicPrompt(
  agent: PreparedAgent,
  tools: ToolSpec[],
  endpoints: EndpointSpec[],
): string {
  return JSON.stringify(
    {
      agent: {
        id: agent.root.annotation.id,
        description: agent.root.annotation.description,
        systemPrompt: agent.root.annotation.systemPrompt,
      },
      tools: tools.map((tool) => ({
        id: tool.id,
        description: tool.description,
        variables: ["input"],
        returnShape: "{ ok: boolean; message: string; input?: string; data?: unknown }",
      })),
      endpoints: endpoints.map((endpoint) => ({
        method: endpoint.method,
        path: endpoint.path,
        description: endpoint.description,
        variables: ["body", "c", "runAgent", "streamAgentResponse"],
        returnShape: "{ status?: number; body: unknown }",
      })),
      outputSchema: {
        tools: [
          {
            id: "tool id",
            executeBody: "TypeScript statements ending in a return statement",
          },
        ],
        endpoints: [
          {
            path: "endpoint path",
            handlerBody: "TypeScript statements ending in a return statement",
          },
        ],
      },
      rules: [
        "Return only JSON.",
        "Do not use imports.",
        "Do not create helper functions.",
        "Use only the provided variables.",
        "Keep the code deterministic and compilable.",
      ],
    },
    null,
    2,
  );
}

function defaultToolBody(tool: ToolSpec): string {
  return [
    "return {",
    "  ok: false,",
    `  message: ${JSON.stringify(`TODO: implement ${tool.id}. ${tool.description}`)},`,
    "  input,",
    "};",
  ].join("\n");
}

function defaultEndpointBody(endpoint: EndpointSpec): string {
  return [
    "return {",
    "  status: 501,",
    "  body: {",
    "    ok: false,",
    `    message: ${JSON.stringify(`TODO: implement ${endpoint.method} ${endpoint.path}. ${endpoint.description}`)},`,
    "    input: body,",
    "  },",
    "};",
  ].join("\n");
}

function collectAgentWarnings(agent: PreparedAgent): string[] {
  const warnings: string[] = [];
  if (agent.root.annotation.tools.some((tool) => tool.id === "exa_search")) {
    warnings.push("Uses exa_search and may require EXA_API_KEY at runtime.");
  }

  return warnings;
}

function summarizeAgent(agent: PreparedAgent, surfaces: SurfaceName[]): AgentSummary {
  const summary = summarizeAnnotation(serializeAnnotation(agent.root.annotation));
  return {
    id: agent.root.annotation.id,
    tools: summary.tools,
    endpoints: summary.endpoints,
    subagents: agent.root.annotation.subagents.length,
    surfaces,
  };
}

function renderAgentFiles(
  cwd: string,
  agent: PreparedAgent,
  config: AuraConfig,
  surfaces: SurfaceName[],
  customLogic: CustomLogicDraft,
): GeneratedFile[] {
  const { agentsDir } = resolveProjectPaths(cwd);
  const baseDir = path.join(agentsDir, agent.root.annotation.id);
  const files: GeneratedFile[] = [
    {
      path: path.join(baseDir, "agent.ts"),
      contents: renderAgentFile(agent, config, customLogic),
      kind: "shared",
    },
    ...agent.descendants.map((section) => ({
      path: path.join(baseDir, "subagents", `${section.annotation.id}.ts`),
      contents: renderSubagentFile(section),
      kind: "shared" as const,
    })),
  ];

  if (surfaces.includes("api")) {
    files.push(
      {
        path: path.join(baseDir, "api", "index.ts"),
        contents: renderApiFile(agent, customLogic),
        kind: "api",
      },
      {
        path: path.join(baseDir, "api", "package.json"),
        contents: renderSurfacePackageJson(agent, "api", config),
        kind: "api",
      },
      {
        path: path.join(baseDir, "api", "tsconfig.json"),
        contents: renderSurfaceTsconfig("api"),
        kind: "api",
      },
    );
  }

  if (surfaces.includes("mcp")) {
    files.push(
      {
        path: path.join(baseDir, "mcp", "index.ts"),
        contents: renderMcpFile(agent),
        kind: "mcp",
      },
      {
        path: path.join(baseDir, "mcp", "package.json"),
        contents: renderSurfacePackageJson(agent, "mcp", config),
        kind: "mcp",
      },
      {
        path: path.join(baseDir, "mcp", "tsconfig.json"),
        contents: renderSurfaceTsconfig("mcp"),
        kind: "mcp",
      },
    );
  }

  if (surfaces.includes("cli")) {
    files.push(
      {
        path: path.join(baseDir, "cli", "index.ts"),
        contents: renderCliFile(agent),
        kind: "cli",
      },
      {
        path: path.join(baseDir, "cli", "package.json"),
        contents: renderSurfacePackageJson(agent, "cli", config),
        kind: "cli",
      },
      {
        path: path.join(baseDir, "cli", "tsconfig.json"),
        contents: renderSurfaceTsconfig("cli"),
        kind: "cli",
      },
    );
  }

  if (surfaces.includes("skill")) {
    files.push({
      path: path.join(baseDir, "SKILL.md"),
      contents: renderSkillFile(agent),
      kind: "skill",
    });
  }

  return files;
}

function renderAgentFile(
  agent: PreparedAgent,
  config: AuraConfig,
  customLogic: CustomLogicDraft,
): string {
  const providerImport = config.model.provider === "anthropic" ? "anthropic" : "openai";
  const providerPackage =
    config.model.provider === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai";
  const hasExa = agent.root.annotation.tools.some((tool) => tool.id === "exa_search");
  const subagentImports = agent.descendants.map(
    (section) =>
      `import { ${toCamelIdentifier(section.annotation.id)}Subagent } from "./subagents/${section.annotation.id}";`,
  );
  const subagentList =
    agent.descendants.length === 0
      ? "export const subagents: Array<SubagentDefinition> = [];\n"
      : [
          "export const subagents: Array<SubagentDefinition> = [",
          ...agent.descendants.map(
            (section) => `  ${toCamelIdentifier(section.annotation.id)}Subagent,`,
          ),
          "];",
          "",
        ].join("\n");

  const toolBlocks = agent.root.annotation.tools.map((tool) =>
    renderToolBlock(tool, customLogic.tools[tool.id] || defaultToolBody(tool)),
  );

  return [
    `import { generateText, streamText, tool } from "ai";`,
    `import { ${providerImport} } from "${providerPackage}";`,
    `import { z } from "zod";`,
    hasExa ? `import Exa from "exa-js";` : "",
    ...subagentImports,
    "",
    `export const AGENT_ID = ${JSON.stringify(agent.root.annotation.id)};`,
    `export const AGENT_PROMPT = ${JSON.stringify(agent.root.annotation.systemPrompt)};`,
    "",
    `export interface AgentMessage {`,
    `  role: "user" | "assistant";`,
    `  content: string;`,
    `}`,
    "",
    `export interface SubagentDefinition {`,
    `  id: string;`,
    `  description: string;`,
    `  systemPrompt: string;`,
    `  run(input: { message: string }): Promise<string>;`,
    `}`,
    "",
    subagentList.trimEnd(),
    hasExa ? `const exa = process.env.EXA_API_KEY ? new Exa(process.env.EXA_API_KEY) : null;` : "",
    hasExa ? "" : "",
    ...toolBlocks.flatMap((block) => [block, ""]),
    `export const agentToolDefinitions = {`,
    ...agent.root.annotation.tools.map((tool) => {
      const identifier = toCamelIdentifier(tool.id);
      return [
        `  ${JSON.stringify(tool.id)}: {`,
        `    description: ${JSON.stringify(tool.description)},`,
        `    parameters: ${identifier}Parameters,`,
        `    execute: execute${toPascalIdentifier(tool.id)},`,
        `  },`,
      ].join("\n");
    }),
    `} as const;`,
    "",
    `export const agentTools = {`,
    ...agent.root.annotation.tools.map((tool) => {
      const identifier = toCamelIdentifier(tool.id);
      return [
        `  ${JSON.stringify(tool.id)}: tool({`,
        `    description: agentToolDefinitions[${JSON.stringify(tool.id)}].description,`,
        `    parameters: z.object(${identifier}Parameters),`,
        `    execute: agentToolDefinitions[${JSON.stringify(tool.id)}].execute,`,
        `  }),`,
      ].join("\n");
    }),
    `};`,
    "",
    `export async function streamAgentResponse(messages: AgentMessage[]) {`,
    `  return streamText({`,
    `    model: ${providerImport}(${JSON.stringify(agent.root.metadata.model)}),`,
    `    system: AGENT_PROMPT,`,
    `    messages,`,
    `    tools: agentTools,`,
    `    maxSteps: ${config.maxSteps},`,
    `  });`,
    `}`,
    "",
    `export async function runAgent(messages: AgentMessage[]) {`,
    `  return generateText({`,
    `    model: ${providerImport}(${JSON.stringify(agent.root.metadata.model)}),`,
    `    system: AGENT_PROMPT,`,
    `    messages,`,
    `    tools: agentTools,`,
    `    maxSteps: ${config.maxSteps},`,
    `  });`,
    `}`,
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderToolBlock(tool: ToolSpec, executeBody: string): string {
  const identifier = toCamelIdentifier(tool.id);
  const pascalId = toPascalIdentifier(tool.id);

  if (tool.id === "exa_search") {
    return [
      `const ${identifier}Parameters = {`,
      `  query: z.string().describe(${JSON.stringify(tool.description || "Search query")}),`,
      `  numResults: z.number().int().min(1).max(10).default(5).describe("Maximum number of results to return"),`,
      `};`,
      `const ${identifier}Schema = z.object(${identifier}Parameters);`,
      `async function execute${pascalId}({ query, numResults }: z.infer<typeof ${identifier}Schema>) {`,
      `  if (!exa) {`,
      `    throw new Error("EXA_API_KEY is required to use exa_search.");`,
      `  }`,
      `  const results = await exa.searchAndContents(query, {`,
      `    numResults,`,
      `    useAutoprompt: true,`,
      `    text: { maxCharacters: 1000 },`,
      `  });`,
      `  return results.results.map((result) => ({`,
      `    title: result.title,`,
      `    url: result.url,`,
      `    content: result.text,`,
      `    publishedDate: result.publishedDate,`,
      `  }));`,
      `}`,
    ].join("\n");
  }

  return [
    `const ${identifier}Parameters = {`,
    `  input: z.string().describe(${JSON.stringify(tool.description)}),`,
    `};`,
    `const ${identifier}Schema = z.object(${identifier}Parameters);`,
    `async function execute${pascalId}({ input }: z.infer<typeof ${identifier}Schema>) {`,
    indentSnippet(executeBody, 2),
    `}`,
  ].join("\n");
}

function renderSubagentFile(section: PreparedSection): string {
  return [
    `export const ${toCamelIdentifier(section.annotation.id)}Subagent = {`,
    `  id: ${JSON.stringify(section.annotation.id)},`,
    `  description: ${JSON.stringify(section.annotation.description)},`,
    `  systemPrompt: ${JSON.stringify(section.annotation.systemPrompt)},`,
    `  async run({ message }: { message: string }): Promise<string> {`,
    `    return [`,
    `      ${JSON.stringify(`Subagent ${section.annotation.id} is ready to help.`)},`,
    `      message,`,
    `    ].filter(Boolean).join("\\n\\n");`,
    `  },`,
    `};`,
    "",
  ].join("\n");
}

function renderApiFile(agent: PreparedAgent, customLogic: CustomLogicDraft): string {
  const chatEndpoint = agent.root.annotation.endpoints.find((endpoint) => isChatEndpoint(endpoint));
  const customEndpoints = agent.root.annotation.endpoints.filter(
    (endpoint) => !isChatEndpoint(endpoint),
  );
  const hasStreamingChat = chatEndpoint?.streaming !== false;

  return [
    `import { Hono, type Context } from "hono";`,
    `import { streamText as honoStream } from "hono/streaming";`,
    `import { runAgent, streamAgentResponse } from "../agent";`,
    "",
    `const app = new Hono();`,
    "",
    `function validateAuth(c: Context): Response | null {`,
    `  const apiKey = process.env.${toEnvIdentifier(agent.root.annotation.id)}_API_KEY;`,
    `  if (!apiKey) {`,
    `    return null;`,
    `  }`,
    `  const token = c.req.header("Authorization")?.replace("Bearer ", "");`,
    `  if (token !== apiKey) {`,
    `    return c.json({ error: "Unauthorized" }, 401);`,
    `  }`,
    `  return null;`,
    `}`,
    "",
    chatEndpoint
      ? renderChatEndpoint(chatEndpoint.method, chatEndpoint.path, hasStreamingChat)
      : "",
    ...customEndpoints.flatMap((endpoint) => [
      renderCustomEndpointHelper(
        endpoint,
        customLogic.endpoints[endpoint.path] || defaultEndpointBody(endpoint),
      ),
      "",
      renderCustomEndpointRoute(endpoint),
      "",
    ]),
    `export default app;`,
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderChatEndpoint(method: string, routePath: string, streaming: boolean): string {
  return [
    `app.on(${JSON.stringify(method.toUpperCase())}, ${JSON.stringify(routePath)}, async (c) => {`,
    `  const authError = validateAuth(c);`,
    `  if (authError) {`,
    `    return authError;`,
    `  }`,
    `  const body = (await c.req.json().catch(() => null)) as {`,
    `    messages?: Array<{ role: "user" | "assistant"; content: string }>;`,
    `  } | null;`,
    `  if (!body?.messages || !Array.isArray(body.messages)) {`,
    `    return c.json({ error: "Invalid request", details: "messages[] is required" }, 400);`,
    `  }`,
    streaming
      ? [
          `  const result = await streamAgentResponse(body.messages);`,
          `  return honoStream(c, async (stream) => {`,
          `    const reader = (await result.toDataStream()).getReader();`,
          `    while (true) {`,
          `      const { done, value } = await reader.read();`,
          `      if (done) {`,
          `        break;`,
          `      }`,
          `      await stream.write(value);`,
          `    }`,
          `  });`,
        ].join("\n")
      : [
          `  const result = await runAgent(body.messages);`,
          `  return c.json({ text: result.text });`,
        ].join("\n"),
    `});`,
  ].join("\n");
}

function renderCustomEndpointHelper(endpoint: EndpointSpec, handlerBody: string): string {
  const helperName = `handle${toPascalIdentifier(endpoint.path)}Request`;
  return [
    `async function ${helperName}(body: unknown, c: Context) {`,
    indentSnippet(handlerBody, 2),
    `}`,
  ].join("\n");
}

function renderCustomEndpointRoute(endpoint: EndpointSpec): string {
  const helperName = `handle${toPascalIdentifier(endpoint.path)}Request`;
  return [
    `app.on(${JSON.stringify(endpoint.method.toUpperCase())}, ${JSON.stringify(endpoint.path)}, async (c) => {`,
    `  const authError = validateAuth(c);`,
    `  if (authError) {`,
    `    return authError;`,
    `  }`,
    `  const body = await c.req.json().catch(() => null);`,
    `  const result = await ${helperName}(body, c);`,
    `  return c.json(result.body, result.status ?? 200);`,
    `});`,
  ].join("\n");
}

function renderMcpFile(agent: PreparedAgent): string {
  const hasChatTool = agent.root.annotation.endpoints.some((endpoint) => isChatEndpoint(endpoint));

  return [
    `import { Hono } from "hono";`,
    `import { StreamableHTTPTransport } from "@hono/mcp";`,
    `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";`,
    `import { z } from "zod";`,
    `import { AGENT_ID, agentToolDefinitions, runAgent } from "../agent";`,
    "",
    `const app = new Hono();`,
    "",
    `function serializeToolResult(value: unknown): string {`,
    `  return typeof value === "string" ? value : JSON.stringify(value, null, 2);`,
    `}`,
    "",
    `function createMcpServer() {`,
    `  const server = new McpServer({`,
    `    name: AGENT_ID,`,
    `    version: "1.0.0",`,
    `  });`,
    hasChatTool
      ? [
          `  server.tool(`,
          `    "chat",`,
          `    "Send a chat message to the agent and receive a response.",`,
          `    {`,
          `      message: z.string().describe("The user message to send"),`,
          `      conversationHistory: z`,
          `        .array(`,
          `          z.object({`,
          `            role: z.enum(["user", "assistant"]),`,
          `            content: z.string(),`,
          `          }),`,
          `        )`,
          `        .optional()`,
          `        .default([]),`,
          `    },`,
          `    async ({ message, conversationHistory }) => {`,
          `      const result = await runAgent([`,
          `        ...conversationHistory,`,
          `        { role: "user", content: message },`,
          `      ]);`,
          `      return {`,
          `        content: [{ type: "text", text: result.text }],`,
          `      };`,
          `    },`,
          `  );`,
          "",
        ].join("\n")
      : "",
    ...agent.root.annotation.tools.flatMap((tool) => [
      `  server.tool(`,
      `    ${JSON.stringify(tool.id)},`,
      `    ${JSON.stringify(tool.description)},`,
      `    agentToolDefinitions[${JSON.stringify(tool.id)}].parameters,`,
      `    async (input) => {`,
      `      const result = await agentToolDefinitions[${JSON.stringify(tool.id)}].execute(input as Parameters<`,
      `        typeof agentToolDefinitions[${JSON.stringify(tool.id)}].execute`,
      `      >[0]);`,
      `      return {`,
      `        content: [{ type: "text", text: serializeToolResult(result) }],`,
      `      };`,
      `    },`,
      `  );`,
      "",
    ]),
    `  return server;`,
    `}`,
    "",
    `app.all("/mcp", async (c) => {`,
    `  const transport = new StreamableHTTPTransport();`,
    `  const server = createMcpServer();`,
    `  await server.connect(transport);`,
    `  return transport.handleRequest(c);`,
    `});`,
    "",
    `export default app;`,
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderCliFile(agent: PreparedAgent): string {
  const endpoints = agent.root.annotation.endpoints.map((endpoint) => ({
    ...endpoint,
    command: endpointToCommandName(endpoint),
  }));
  const hasChatEndpoint = endpoints.some((endpoint) => endpoint.command === "chat");

  return [
    `#!/usr/bin/env bun`,
    `import { createDataStreamDecoder } from "ai";`,
    "",
    `const DEFAULT_URL = process.env.${toEnvIdentifier(agent.root.annotation.id)}_URL || "http://localhost:3000";`,
    "",
    `const COMMANDS = ${JSON.stringify(
      endpoints.map((endpoint) => ({
        command: endpoint.command,
        method: endpoint.method,
        path: endpoint.path,
        streaming: endpoint.streaming === true || endpoint.command === "chat",
      })),
      null,
      2,
    )} as const;`,
    "",
    `async function sendJson(pathname: string, method: string, body: unknown) {`,
    `  const apiKey = process.env.${toEnvIdentifier(agent.root.annotation.id)}_API_KEY;`,
    `  const headers: Record<string, string> = { "Content-Type": "application/json" };`,
    `  if (apiKey) {`,
    `    headers.Authorization = \`Bearer \${apiKey}\`;`,
    `  }`,
    `  const response = await fetch(\`\${DEFAULT_URL.replace(/\\/$/, "")}\${pathname}\`, {`,
    `    method,`,
    `    headers,`,
    `    body: JSON.stringify(body),`,
    `  });`,
    `  if (!response.ok) {`,
    `    throw new Error(\`Agent error \${response.status}: \${await response.text()}\`);`,
    `  }`,
    `  return response;`,
    `}`,
    "",
    `async function runChat(prompt: string) {`,
    `  const descriptor = COMMANDS.find((entry) => entry.command === "chat");`,
    `  if (!descriptor) {`,
    `    throw new Error("This agent does not expose a chat command.");`,
    `  }`,
    `  const response = await sendJson(descriptor.path, descriptor.method, {`,
    `    messages: [{ role: "user", content: prompt }],`,
    `  });`,
    `  const contentType = response.headers.get("content-type") || "";`,
    `  if (contentType.includes("application/json")) {`,
    `    const payload = (await response.json()) as { text?: string };`,
    `    process.stdout.write(\`\${payload.text ?? JSON.stringify(payload, null, 2)}\\n\`);`,
    `    return;`,
    `  }`,
    `  const decoder = createDataStreamDecoder();`,
    `  const reader = response.body?.getReader();`,
    `  if (!reader) {`,
    `    return;`,
    `  }`,
    `  while (true) {`,
    `    const { done, value } = await reader.read();`,
    `    if (done) {`,
    `      break;`,
    `    }`,
    `    for (const part of decoder.decode(value)) {`,
    `      if (part.type === "text-delta") {`,
    `        process.stdout.write(part.textDelta);`,
    `      }`,
    `    }`,
    `  }`,
    `  process.stdout.write("\\n");`,
    `}`,
    "",
    `async function runEndpoint(command: string, payloadText: string) {`,
    `  const descriptor = COMMANDS.find((entry) => entry.command === command);`,
    `  if (!descriptor) {`,
    `    throw new Error(\`Unknown command "\${command}"\`);`,
    `  }`,
    `  const payload = payloadText ? JSON.parse(payloadText) : {};`,
    `  const response = await sendJson(descriptor.path, descriptor.method, payload);`,
    `  const contentType = response.headers.get("content-type") || "";`,
    `  if (contentType.includes("application/json")) {`,
    `    process.stdout.write(\`\${JSON.stringify(await response.json(), null, 2)}\\n\`);`,
    `    return;`,
    `  }`,
    `  process.stdout.write(\`\${await response.text()}\\n\`);`,
    `}`,
    "",
    `async function main() {`,
    `  const [command, ...rest] = process.argv.slice(2);`,
    `  if (!command) {`,
    `    console.error(${JSON.stringify(renderCliUsage(agent, endpoints))});`,
    `    process.exit(1);`,
    `  }`,
    hasChatEndpoint
      ? [
          `  if (command === "chat") {`,
          `    const prompt = rest.join(" ").trim();`,
          `    if (!prompt) {`,
          `      throw new Error("Missing chat message.");`,
          `    }`,
          `    await runChat(prompt);`,
          `    return;`,
          `  }`,
        ].join("\n")
      : "",
    `  await runEndpoint(command, rest.join(" ").trim());`,
    `}`,
    "",
    `await main();`,
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderCliUsage(
  agent: PreparedAgent,
  endpoints: Array<{ command: string; path: string }>,
): string {
  const lines = [
    `Usage: ${agent.root.annotation.id} <command> [payload]`,
    "",
    "Commands:",
    ...endpoints.map((endpoint) => `  ${endpoint.command.padEnd(10)} ${endpoint.path}`),
  ];

  return lines.join("\n");
}

function renderSkillFile(agent: PreparedAgent): string {
  const hasChatEndpoint = agent.root.annotation.endpoints.some((endpoint) =>
    isChatEndpoint(endpoint),
  );
  const usage = hasChatEndpoint
    ? `npx @satorico/${agent.root.annotation.id} chat "Your message here"`
    : `npx @satorico/${agent.root.annotation.id} ${endpointToCommandName(
        agent.root.annotation.endpoints[0] ?? {
          method: "POST",
          path: "/run",
          description: "",
        },
      )} '{}'`;

  return [
    "---",
    `name: ${agent.root.annotation.id}`,
    "description: |",
    `  ${agent.root.annotation.description}`,
    "",
    "  TRIGGERS - Use this skill when:",
    `  - The task matches ${agent.root.annotation.description.toLowerCase()}`,
    hasChatEndpoint ? "  - The user wants to interact conversationally with this agent" : "",
    agent.root.annotation.tools.length > 0
      ? `  - The user needs help with ${agent.root.annotation.tools.map((tool) => tool.id).join(", ")}`
      : "",
    "---",
    "",
    "## Usage",
    "",
    "```bash",
    usage,
    "```",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderSurfacePackageJson(
  agent: PreparedAgent,
  surface: Exclude<SurfaceName, "skill">,
  config: AuraConfig,
): string {
  const providerPackage =
    config.model.provider === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai";
  const sharedDependencies =
    surface === "cli"
      ? {
          ai: "^4.0.0",
        }
      : {
          ai: "^4.0.0",
          [providerPackage]: "^2.0.0",
          zod: "^3.24.0",
          ...(agent.root.annotation.tools.some((tool) => tool.id === "exa_search")
            ? { "exa-js": "^1.7.1" }
            : {}),
        };

  const surfaceDependencies =
    surface === "api"
      ? {
          hono: "^4.7.2",
        }
      : surface === "mcp"
        ? {
            hono: "^4.7.2",
            "@hono/mcp": "^0.1.0",
            "@modelcontextprotocol/sdk": "^1.13.0",
          }
        : {};

  const payload: Record<string, unknown> = {
    name:
      surface === "cli"
        ? `@satorico/${agent.root.annotation.id}`
        : `${agent.root.annotation.id}-${surface}`,
    version: "1.0.0",
    type: "module",
    private: surface === "cli" ? undefined : true,
    description: `${agent.root.annotation.id} ${surface} surface generated by aura`,
    scripts: {
      build: "tsc --noEmit -p tsconfig.json",
    },
    dependencies: {
      ...sharedDependencies,
      ...surfaceDependencies,
    },
    devDependencies: {
      "@types/node": "^20.0.0",
      typescript: "^5.0.0",
    },
    engines: surface === "cli" ? { bun: ">=1.0.0" } : { node: ">=20" },
  };

  if (surface === "cli") {
    payload.bin = {
      [agent.root.annotation.id]: "./index.ts",
    };
  }

  return `${JSON.stringify(stripUndefined(payload), null, 2)}\n`;
}

function renderSurfaceTsconfig(surface: Exclude<SurfaceName, "skill">): string {
  const include =
    surface === "cli" ? ["./**/*.ts"] : ["./**/*.ts", "../agent.ts", "../subagents/**/*.ts"];

  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        verbatimModuleSyntax: true,
        allowSyntheticDefaultImports: true,
        resolveJsonModule: true,
        lib: ["ES2022", "DOM"],
        types: ["node"],
      },
      include,
    },
    null,
    2,
  )}\n`;
}

async function clearGeneratedOutputs(
  bundle: GeneratedAgentBundle,
  surfaces: SurfaceName[],
): Promise<void> {
  const baseDir = path.dirname(bundle.files[0]!.path);

  await rm(path.join(baseDir, "agent.ts"), { force: true });
  await rm(path.join(baseDir, "subagents"), { recursive: true, force: true });

  for (const surface of surfaces) {
    if (surface === "skill") {
      await rm(path.join(baseDir, "SKILL.md"), { force: true });
      continue;
    }

    await rm(path.join(baseDir, surface), { recursive: true, force: true });
  }
}

function detectPackageManager(cwd: string): "bun" | "npm" | "pnpm" | "yarn" {
  try {
    const raw = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")) as {
      packageManager?: string;
    };
    const packageManager = raw.packageManager;
    if (typeof packageManager === "string") {
      const name = packageManager.split("@")[0];
      if (name === "bun" || name === "npm" || name === "pnpm" || name === "yarn") {
        return name;
      }
    }
  } catch {
    // Ignore and fall back.
  }

  return "npm";
}

function getInstallCommand(packageManager: "bun" | "npm" | "pnpm" | "yarn"): {
  command: string;
  args: string[];
} {
  switch (packageManager) {
    case "bun":
      return { command: "bun", args: ["install"] };
    case "pnpm":
      return { command: "pnpm", args: ["install", "--ignore-scripts"] };
    case "yarn":
      return { command: "yarn", args: ["install", "--ignore-scripts"] };
    case "npm":
    default:
      return { command: "npm", args: ["install", "--ignore-scripts"] };
  }
}

function getRunScriptCommand(
  packageManager: "bun" | "npm" | "pnpm" | "yarn",
  script: string,
): { command: string; args: string[] } {
  switch (packageManager) {
    case "bun":
      return { command: "bun", args: ["run", script] };
    case "pnpm":
      return { command: "pnpm", args: ["run", script] };
    case "yarn":
      return { command: "yarn", args: [script] };
    case "npm":
    default:
      return { command: "npm", args: ["run", script] };
  }
}

async function runCommand(cwd: string, command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error([stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n")));
    });
  });
}

async function cleanupValidationArtifacts(surfaceDir: string): Promise<void> {
  await Promise.all(
    [
      "node_modules",
      "package-lock.json",
      "bun.lock",
      "bun.lockb",
      "pnpm-lock.yaml",
      "yarn.lock",
    ].map((name) => rm(path.join(surfaceDir, name), { recursive: true, force: true })),
  );
}

function isBuiltInTool(id: string): boolean {
  return id === "exa_search";
}

function isChatEndpoint(endpoint: EndpointSpec): boolean {
  return endpointToCommandName(endpoint) === "chat";
}

function endpointToCommandName(endpoint: EndpointSpec): string {
  const segments = endpoint.path.split("/").filter(Boolean);
  return toSlug(segments.at(-1) ?? endpoint.path) || "run";
}

function toCamelIdentifier(value: string): string {
  const parts = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const [first = "value", ...rest] = parts;
  return [
    first.toLowerCase(),
    ...rest.map((part) => `${part[0]!.toUpperCase()}${part.slice(1).toLowerCase()}`),
  ].join("");
}

function toPascalIdentifier(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join("");
}

function toEnvIdentifier(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function indentSnippet(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripUndefined(entry)) as T;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, stripUndefined(entry)] as const);
    return Object.fromEntries(entries) as T;
  }

  return value;
}

export { ALL_SURFACES };

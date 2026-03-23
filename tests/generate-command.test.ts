import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { runGenerate, type GeneratePromptAdapter } from "../src/cli/commands/generate";
import type { SurfaceName } from "../src/core/agent-schema";
import type { JsonGenerationRequest, ModelClient } from "../src/core/model-client";
import type { ValidationRunner } from "../src/core/generate";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("runGenerate", () => {
  test("generates targeted shared files and one surface", async () => {
    const cwd = await createTempProject(`# Aura Agents

## Support Bot
Handles customer support.

### Billing Agent
Handles billing questions.

## Code Reviewer
Reviews pull requests.
`);
    const prompts = new TestPrompts({
      confirms: [true],
    });
    const validationCalls: Array<{ agentId: string; surface: SurfaceName; surfaceDir: string }> =
      [];

    await runGenerate(["support-bot", "api"], cwd, {
      prompts,
      modelClientFactory: () =>
        createFakeModelClient({
          sectionDrafts: {
            "support-bot": {
              systemPrompt: "Support customers quickly.",
              tools: [{ id: "lookup_order", description: "Look up customer orders" }],
              endpoints: [
                {
                  method: "POST",
                  path: "/chat",
                  description: "Chat with customers",
                  streaming: true,
                },
              ],
            },
            "billing-agent": {
              systemPrompt: "Handle billing questions.",
              tools: [],
              endpoints: [],
            },
          },
        }),
      validationRunnerFactory: () => ({
        async validate(agentId, surface, surfaceDir) {
          validationCalls.push({ agentId, surface, surfaceDir });
        },
      }),
    });

    expect(await readFile(path.join(cwd, "aura.md"), "utf8")).toContain("```annotation");
    expect(await readFile(path.join(cwd, "src/agents/support-bot/agent.ts"), "utf8")).toContain(
      "Support customers quickly.",
    );
    expect(
      await readFile(path.join(cwd, "src/agents/support-bot/subagents/billing-agent.ts"), "utf8"),
    ).toContain("billing-agent");
    expect(await readFile(path.join(cwd, "src/agents/support-bot/api/index.ts"), "utf8")).toContain(
      '"/chat"',
    );
    expect(validationCalls).toEqual([
      {
        agentId: "support-bot",
        surface: "api",
        surfaceDir: path.join(cwd, "src/agents/support-bot/api"),
      },
    ]);
    await expect(
      readFile(path.join(cwd, "src/agents/support-bot/mcp/index.ts"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(cwd, "src/agents/code-reviewer/agent.ts"), "utf8"),
    ).rejects.toThrow();
  });

  test("dry-run does not write generated files or aura.md updates", async () => {
    const cwd = await createTempProject(`# Aura Agents

## Support Bot
Handles customer support.
`);
    const original = await readFile(path.join(cwd, "aura.md"), "utf8");
    const prompts = new TestPrompts({
      surfaces: ["api"],
    });

    await runGenerate(["--dry-run"], cwd, {
      prompts,
      modelClientFactory: () =>
        createFakeModelClient({
          sectionDrafts: {
            "support-bot": {
              systemPrompt: "Support customers quickly.",
              tools: [],
              endpoints: [
                {
                  method: "POST",
                  path: "/chat",
                  description: "Chat with customers",
                  streaming: true,
                },
              ],
            },
          },
        }),
      validationRunnerFactory: () =>
        failingValidationRunner("validation should not run during dry-run"),
    });

    expect(await readFile(path.join(cwd, "aura.md"), "utf8")).toBe(original);
    await expect(
      readFile(path.join(cwd, "src/agents/support-bot/agent.ts"), "utf8"),
    ).rejects.toThrow();
  });

  test("warns when targeted output already exists", async () => {
    const cwd = await createTempProject(`# Aura Agents

## Support Bot
Handles customer support.
`);
    const modelClientFactory = () =>
      createFakeModelClient({
        sectionDrafts: {
          "support-bot": {
            systemPrompt: "Support customers quickly.",
            tools: [],
            endpoints: [
              {
                method: "POST",
                path: "/chat",
                description: "Chat with customers",
                streaming: true,
              },
            ],
          },
        },
      });

    await runGenerate(["support-bot", "api"], cwd, {
      prompts: new TestPrompts({ confirms: [true] }),
      modelClientFactory,
      validationRunnerFactory: () => noOpValidationRunner(),
    });

    const prompts = new TestPrompts({ confirms: [true] });
    await runGenerate(["support-bot", "api"], cwd, {
      prompts,
      modelClientFactory,
      validationRunnerFactory: () => noOpValidationRunner(),
    });

    expect(prompts.warnings.some((message) => message.includes("already exists"))).toBe(true);
  });
});

class TestPrompts implements GeneratePromptAdapter {
  readonly warnings: string[] = [];
  readonly infos: string[] = [];
  readonly notes: string[] = [];
  private readonly confirms: boolean[];
  private readonly surfaces: SurfaceName[];
  private readonly inputs: string[];

  constructor(options: { confirms?: boolean[]; surfaces?: SurfaceName[]; inputs?: string[] }) {
    this.confirms = [...(options.confirms ?? [])];
    this.surfaces = options.surfaces ?? ["api", "mcp", "cli", "skill"];
    this.inputs = [...(options.inputs ?? [])];
  }

  async confirm(): Promise<boolean> {
    return this.confirms.shift() ?? true;
  }

  async multiselectSurfaces(): Promise<SurfaceName[]> {
    return this.surfaces;
  }

  async input(): Promise<string> {
    return this.inputs.shift() ?? "";
  }

  async pause(): Promise<void> {}

  logSuccess(message: string): void {
    this.infos.push(message);
  }

  logWarn(message: string): void {
    this.warnings.push(message);
  }

  note(message: string): void {
    this.notes.push(message);
  }

  info(message: string): void {
    this.infos.push(message);
  }
}

function createFakeModelClient(options?: {
  sectionDrafts?: Record<string, unknown>;
  customLogic?: unknown;
}): ModelClient {
  return {
    async generateJson<T>(request: JsonGenerationRequest): Promise<T> {
      const payload = JSON.parse(request.prompt) as Record<string, unknown>;
      if ("section" in payload) {
        const section = payload.section as { slug: string };
        return (options?.sectionDrafts?.[section.slug] ?? {
          systemPrompt: `Prompt for ${section.slug}`,
          tools: [],
          endpoints: [],
        }) as T;
      }

      return (options?.customLogic ?? { tools: [], endpoints: [] }) as T;
    },
  };
}

async function createTempProject(auraMarkdown: string): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "aura-generate-command-"));
  tempDirectories.push(cwd);
  await writeFile(path.join(cwd, "aura.md"), auraMarkdown, "utf8");
  return cwd;
}

function noOpValidationRunner(): ValidationRunner {
  return {
    async validate() {},
  };
}

function failingValidationRunner(message: string): ValidationRunner {
  return {
    async validate() {
      throw new Error(message);
    },
  };
}

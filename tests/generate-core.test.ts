import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { parseAuraMarkdown } from "../src/core/aura-md";
import { DEFAULT_CONFIG } from "../src/core/config";
import {
  buildGeneratedBundles,
  ensureManagedBlocks,
  parseGenerateOptions,
  prepareAgentsFromManagedBlocks,
  resolveGenerateTargets,
} from "../src/core/generate";
import type { JsonGenerationRequest, ModelClient } from "../src/core/model-client";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("generate core", () => {
  test("parses generate options", () => {
    expect(parseGenerateOptions(["support-bot", "api", "--dry-run"])).toEqual({
      agent: "support-bot",
      surface: "api",
      dryRun: true,
    });
  });

  test("extracts missing managed blocks with the model client", async () => {
    const document = parseAuraMarkdown(`# Aura Agents

## Support Bot
Handles customer support.

### Billing Agent
Handles billing questions.
`);
    const modelClient = createFakeModelClient({
      sectionDrafts: {
        "support-bot": {
          systemPrompt: "Help support users quickly.",
          tools: [{ id: "lookup_order", description: "Look up customer orders" }],
          endpoints: [
            { method: "POST", path: "/chat", description: "Chat with the agent", streaming: true },
          ],
        },
        "billing-agent": {
          systemPrompt: "Handle billing questions only.",
          tools: [],
          endpoints: [],
        },
      },
    });

    const result = await ensureManagedBlocks(
      document,
      resolveGenerateTargets(document, { dryRun: false }),
      DEFAULT_CONFIG,
      modelClient,
    );

    expect(result.document.raw).toContain("```annotation");
    expect(result.document.raw).toContain("```metadata");
    expect(result.preparedAgents[0]?.root.annotation.id).toBe("support-bot");
    expect(result.preparedAgents[0]?.root.annotation.subagents).toEqual(["billing-agent"]);
    expect(result.preparedAgents[0]?.descendants[0]?.annotation.id).toBe("billing-agent");
  });

  test("skips extraction when managed blocks already exist", async () => {
    const document = parseAuraMarkdown(`# Aura Agents

## Support Bot
Handles customer support.

\`\`\`annotation
id: support-bot
description: Handles customer support.
systemPrompt: |
  Help support users quickly.
tools: []
endpoints: []
subagents: []
\`\`\`

\`\`\`metadata
model: gpt-5.2
\`\`\`
`);
    const modelClient = createFakeModelClient();

    const result = await ensureManagedBlocks(
      document,
      resolveGenerateTargets(document, { dryRun: false }),
      DEFAULT_CONFIG,
      modelClient,
    );

    expect(modelClient.calls).toHaveLength(0);
    expect(result.preparedAgents[0]?.root.annotation.systemPrompt).toBe(
      "Help support users quickly.",
    );
  });

  test("drafts custom tool and endpoint logic into generated files", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "aura-generate-core-"));
    tempDirectories.push(cwd);

    const document = parseAuraMarkdown(`# Aura Agents

## Support Bot
Handles customer support.

\`\`\`annotation
id: support-bot
description: Handles customer support.
systemPrompt: |
  Help support users quickly.
tools:
  - id: lookup_order
    description: Look up customer orders
endpoints:
  - method: POST
    path: /chat
    description: Chat with the agent
    streaming: true
  - method: POST
    path: /escalate
    description: Escalate to a human
subagents: []
\`\`\`

\`\`\`metadata
model: gpt-5.2
\`\`\`
`);
    const agents = prepareAgentsFromManagedBlocks(
      document,
      resolveGenerateTargets(document, { agent: "support-bot", dryRun: false }),
    );
    const modelClient = createFakeModelClient({
      customLogic: {
        tools: [
          {
            id: "lookup_order",
            executeBody:
              'return { ok: true, message: "Fetched order details.", input, data: { orderId: input } };',
          },
        ],
        endpoints: [
          {
            path: "/escalate",
            handlerBody:
              'return { status: 202, body: { ok: true, message: "Escalation queued.", payload: body } };',
          },
        ],
      },
    });

    const bundles = await buildGeneratedBundles(cwd, agents, DEFAULT_CONFIG, ["api"], modelClient);
    const agentFile = bundles[0]?.files.find((file) => file.path.endsWith("/agent.ts"));
    const apiFile = bundles[0]?.files.find((file) => file.path.endsWith("/api/index.ts"));

    expect(agentFile?.contents).toContain("Fetched order details.");
    expect(apiFile?.contents).toContain("Escalation queued.");
    expect(apiFile?.contents).toContain("handleEscalateRequest");
  });
});

function createFakeModelClient(options?: {
  sectionDrafts?: Record<string, unknown>;
  customLogic?: unknown;
}): ModelClient & { calls: JsonGenerationRequest[] } {
  const calls: JsonGenerationRequest[] = [];

  return {
    calls,
    async generateJson<T>(request: JsonGenerationRequest): Promise<T> {
      calls.push(request);
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

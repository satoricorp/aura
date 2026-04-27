import { afterEach, describe, expect, test } from "bun:test";
import http from "node:http";
import { generateVerdict, buildVerdictUserMessage } from "../src/core/proxy/verdict";
import type { SessionSummary, Verdict } from "../src/core/proxy/types";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("verdict generation", () => {
  test("builds the verdict prompt from captured session data", () => {
    const prompt = buildVerdictUserMessage(createSummary("fix parser"));

    expect(prompt).toContain("ORIGINAL TASK:\nfix parser");
    expect(prompt).toContain("1. Edit(");
    expect(prompt).toContain("AGENT'S FINAL MESSAGE:\nUpdated parser.ts");
    expect(prompt).toContain("modified src/utils/parser.ts");
  });

  test("calls Anthropic with the captured API key and parses verdict JSON", async () => {
    let observedApiKey = "";
    const verdict = createVerdict("APPROVED", "Parser fix stayed in scope");
    const upstream = await createJsonServer((request, response) => {
      observedApiKey = String(request.headers["x-api-key"] ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          content: [{ type: "text", text: JSON.stringify(verdict) }],
        }),
      );
    });

    const result = await generateVerdict({
      headers: { "x-api-key": "secret-key", "anthropic-version": "2023-06-01" },
      model: "claude-haiku-test",
      summary: createSummary("fix parser"),
      upstreamOrigin: upstream,
    });

    expect(observedApiKey).toBe("secret-key");
    expect(result).toEqual(verdict);
  });

  test("parses fenced verdict JSON", async () => {
    const verdict = createVerdict("APPROVED", "Parser fix stayed in scope");
    const upstream = await createJsonServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`` }],
        }),
      );
    });

    const result = await generateVerdict({
      headers: { "x-api-key": "secret-key" },
      model: "claude-haiku-test",
      summary: createSummary("fix parser"),
      upstreamOrigin: upstream,
    });

    expect(result).toEqual(verdict);
  });

  test.each([
    ["fix the null check in src/utils/parser.ts line 42", "APPROVED"],
    ["refactor auth to use Better Auth", "REVIEW"],
    ["all tests pass", "STOP"],
    ["convert all class components to function components", "APPROVED"],
    ["read the auth files", "APPROVED"],
    ["continue the task", "REVIEW"],
  ] as const)("supports acceptance scenario verdict: %s", async (task, status) => {
    const upstream = await createJsonServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          content: [{ type: "text", text: JSON.stringify(createVerdict(status, task)) }],
        }),
      );
    });

    const result = await generateVerdict({
      headers: { "x-api-key": "secret-key" },
      model: "claude-haiku-test",
      summary: createSummary(task),
      upstreamOrigin: upstream,
    });

    expect(result.status).toBe(status);
  });
});

function createSummary(originalTask: string): SessionSummary {
  return {
    finalAssistantText: "Updated parser.ts",
    filesTouched: [
      {
        action: "modified",
        note: "updated parser null check",
        path: "src/utils/parser.ts",
      },
    ],
    inputTokens: 10,
    outputTokens: 20,
    originalTask,
    requestId: "req_test",
    sessionLogPath: "/tmp/session.jsonl",
    toolCalls: [
      {
        input: { file_path: "src/utils/parser.ts" },
        summary: "Edit src/utils/parser.ts",
        tool_name: "Edit",
      },
    ],
  };
}

function createVerdict(status: Verdict["status"], summary: string): Verdict {
  return {
    status,
    summary,
    task_understanding: "Handle the requested coding task",
    changes: [
      {
        action: "modified",
        note: "changed parser logic",
        path: "src/utils/parser.ts",
      },
    ],
    risks: status === "APPROVED" ? [] : ["Needs review"],
    claimed_vs_actual: status === "STOP" ? ["Claimed tests without evidence"] : [],
    next_step: status === "APPROVED" ? "Ready to commit" : "Review before commit",
  };
}

async function createJsonServer(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected server address.");
  }

  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

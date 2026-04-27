import { afterEach, describe, expect, test } from "bun:test";
import http, { type IncomingMessage } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startProxyServer } from "../src/core/proxy/server";

const servers: http.Server[] = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("startProxyServer", () => {
  test("forwards streaming Anthropic responses and captures a session log", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "aura-proxy-"));
    tempDirectories.push(logDir);
    let observedAcceptEncoding = "";
    let observedBody = "";
    let observedApiKey = "";

    const upstreamOrigin = await createServer((request, response) => {
      observedAcceptEncoding = String(request.headers["accept-encoding"] ?? "");
      observedApiKey = String(request.headers["x-api-key"] ?? "");
      void readRequestBody(request).then((body) => {
        observedBody = body;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { text: "Done" },
          })}\n\n`,
        );
        response.end(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      });
    });

    const proxy = await startProxyServer({
      config: {
        clipboardDisabled: true,
        logDir,
        port: 0,
        upstreamOrigin,
        verdictDisabled: true,
        verdictModel: "claude-test",
      },
    });
    servers.push(proxy);
    const proxyOrigin = serverOrigin(proxy);
    const body = JSON.stringify({
      max_tokens: 100,
      messages: [{ role: "user", content: "say done" }],
      model: "claude-test",
      stream: true,
    });

    const response = await request(proxyOrigin, "/v1/messages", {
      body,
      headers: {
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "application/json",
        "x-api-key": "secret-key",
      },
      method: "POST",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("message_stop");
    expect(observedBody).toBe(body);
    expect(observedAcceptEncoding).toBe("identity");
    expect(observedApiKey).toBe("secret-key");

    const log = await waitForSessionLog(logDir);
    expect(log).toContain('"type":"request"');
    expect(log).toContain('"type":"response_event"');
    expect(log).toContain('"type":"session_end"');
    expect(log).not.toContain("secret-key");
  });

  test("appends the Aura verdict to streaming responses", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "aura-proxy-"));
    tempDirectories.push(logDir);
    let clipboardText = "";
    let stderr = "";
    let stdout = "";

    const upstreamOrigin = await createServer((request, response) => {
      void readRequestBody(request).then((body) => {
        const parsed = JSON.parse(body) as { stream?: boolean };
        if (!parsed.stream) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    status: "APPROVED",
                    summary: "README created",
                    task_understanding: "Create README",
                    changes: [{ path: "README.md", action: "created", note: "created README" }],
                    risks: [],
                    claimed_vs_actual: [],
                    next_step: "Ready to commit",
                  }),
                },
              ],
            }),
          );
          return;
        }

        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Created README.md" },
          })}\n\n`,
        );
        response.write(`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
        response.write(
          `data: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 4 },
          })}\n\n`,
        );
        response.end(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      });
    });

    const proxy = await startProxyServer({
      config: {
        clipboardDisabled: false,
        logDir,
        port: 0,
        upstreamOrigin,
        verdictDisabled: false,
        verdictModel: "claude-test",
      },
      clipboardRunner: async (_command, _args, input) => {
        clipboardText = input;
      },
      stderr: {
        write: (chunk) => {
          stderr += String(chunk);
          return true;
        },
      },
      stdout: {
        write: (chunk) => {
          stdout += String(chunk);
          return true;
        },
      },
    });
    servers.push(proxy);
    const body = JSON.stringify({
      max_tokens: 100,
      messages: [
        { role: "user", content: "create README" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Write",
              input: { file_path: "README.md", content: "# README" },
            },
          ],
        },
      ],
      model: "claude-test",
      stream: true,
    });

    const response = await request(serverOrigin(proxy), "/v1/messages", {
      body,
      headers: {
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "application/json",
        "x-api-key": "secret-key",
      },
      method: "POST",
    });

    expect(response.body).toContain("Created README.md");
    expect(response.body).toContain("Aura: APPROVED - README created");
    expect(response.body).toContain("event: content_block_start");
    expect(response.body).toContain("event: content_block_delta");
    expect(response.body).toContain("event: content_block_stop");
    expect(response.body.indexOf("Aura:")).toBeLessThan(response.body.lastIndexOf("message_stop"));
    expect(clipboardText).toContain("Continue from Aura's review:");
    expect(clipboardText).toContain("Ready to commit");
    expect(stderr).toContain("Aura copied next step to clipboard.");
    expect(stdout.trim()).not.toContain("\n");
    expect(JSON.parse(stdout)).toEqual({
      type: "aura_verdict",
      model: "claude-test",
      request_id: expect.any(String),
      injected: true,
      status: "APPROVED",
      summary: "README created",
      task_understanding: "Create README",
      changes: [{ path: "README.md", action: "created", note: "created README" }],
      risks: [],
      claimed_vs_actual: [],
      next_step: "Ready to commit",
    });

    const log = await waitForSessionLog(logDir);
    expect(log).toContain('"type":"verdict"');
    expect(log).toContain("README.md");
  });

  test("does not append verdicts to tool-use streaming responses", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "aura-proxy-"));
    tempDirectories.push(logDir);
    let verdictCalls = 0;

    const upstreamOrigin = await createServer((request, response) => {
      void readRequestBody(request).then((body) => {
        const parsed = JSON.parse(body) as { stream?: boolean };
        if (!parsed.stream) {
          verdictCalls += 1;
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
          return;
        }

        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Let me read the README first." },
          })}\n\n`,
        );
        response.write(`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
        response.write(
          `data: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 8 },
          })}\n\n`,
        );
        response.end(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      });
    });

    const proxy = await startProxyServer({
      config: {
        clipboardDisabled: true,
        logDir,
        port: 0,
        upstreamOrigin,
        verdictDisabled: false,
        verdictModel: "claude-test",
      },
    });
    servers.push(proxy);
    const body = JSON.stringify({
      max_tokens: 100,
      messages: [{ role: "user", content: "add a line to README" }],
      model: "claude-test",
      stream: true,
    });

    const response = await request(serverOrigin(proxy), "/v1/messages", {
      body,
      headers: {
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "application/json",
        "x-api-key": "secret-key",
      },
      method: "POST",
    });

    expect(response.body).toContain("Let me read the README first.");
    expect(response.body).not.toContain("AURA");
    expect(verdictCalls).toBe(0);

    const log = await waitForSessionLog(logDir);
    expect(log).toContain('"type":"session_end"');
    expect(log).not.toContain('"type":"verdict"');
  });

  test("copies correction prompts for dangerous tool-use responses without blocking them", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "aura-proxy-"));
    tempDirectories.push(logDir);
    let clipboardText = "";
    let stderr = "";
    let verdictCalls = 0;

    const upstreamOrigin = await createServer((request, response) => {
      void readRequestBody(request).then((body) => {
        const parsed = JSON.parse(body) as { stream?: boolean };
        if (!parsed.stream) {
          verdictCalls += 1;
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
          return;
        }

        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", name: "Bash", input: {} },
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { partial_json: '{"command":"rm -rf /tmp/aura"}' },
          })}\n\n`,
        );
        response.write(`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
        response.write(
          `data: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 8 },
          })}\n\n`,
        );
        response.end(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      });
    });

    const proxy = await startProxyServer({
      config: {
        clipboardDisabled: false,
        logDir,
        port: 0,
        upstreamOrigin,
        verdictDisabled: false,
        verdictModel: "claude-test",
      },
      clipboardRunner: async (_command, _args, input) => {
        clipboardText = input;
      },
      stderr: {
        write: (chunk) => {
          stderr += String(chunk);
          return true;
        },
      },
    });
    servers.push(proxy);
    const body = JSON.stringify({
      max_tokens: 100,
      messages: [{ role: "user", content: "clean temp files" }],
      model: "claude-test",
      stream: true,
    });

    const response = await request(serverOrigin(proxy), "/v1/messages", {
      body,
      headers: {
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "application/json",
        "x-api-key": "secret-key",
      },
      method: "POST",
    });

    expect(response.body).toContain("rm -rf /tmp/aura");
    expect(response.body).not.toContain("Aura:");
    expect(clipboardText).toContain("Continue with Aura's steering:");
    expect(clipboardText).toContain("Pause before running `rm -rf /tmp/aura`.");
    expect(stderr).toContain("Aura copied steering prompt to clipboard.");
    expect(verdictCalls).toBe(0);
  });

  test("does not append verdicts to Claude recap responses", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "aura-proxy-"));
    tempDirectories.push(logDir);
    let verdictCalls = 0;

    const upstreamOrigin = await createServer((request, response) => {
      void readRequestBody(request).then((body) => {
        const parsed = JSON.parse(body) as { stream?: boolean };
        if (!parsed.stream) {
          verdictCalls += 1;
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
          return;
        }

        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: '※ recap: Added a new line "testing aura 2" to the README.',
            },
          })}\n\n`,
        );
        response.write(`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
        response.write(
          `data: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 8 },
          })}\n\n`,
        );
        response.end(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      });
    });

    const proxy = await startProxyServer({
      config: {
        clipboardDisabled: true,
        logDir,
        port: 0,
        upstreamOrigin,
        verdictDisabled: false,
        verdictModel: "claude-test",
      },
    });
    servers.push(proxy);
    const body = JSON.stringify({
      max_tokens: 100,
      messages: [
        { role: "user", content: "add a line to README" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Edit",
              input: { file_path: "README.md", new_string: "testing aura 2" },
            },
          ],
        },
      ],
      model: "claude-test",
      stream: true,
    });

    const response = await request(serverOrigin(proxy), "/v1/messages", {
      body,
      headers: {
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "application/json",
        "x-api-key": "secret-key",
      },
      method: "POST",
    });

    expect(response.body).toContain("※ recap:");
    expect(response.body).not.toContain("Aura:");
    expect(verdictCalls).toBe(0);

    const log = await waitForSessionLog(logDir);
    expect(log).toContain('"type":"session_end"');
    expect(log).not.toContain('"type":"verdict"');
  });

  test("returns 404 outside /v1", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "aura-proxy-"));
    tempDirectories.push(logDir);
    const upstreamOrigin = await createServer((_request, response) => {
      response.end("unexpected");
    });
    const proxy = await startProxyServer({
      config: {
        clipboardDisabled: true,
        logDir,
        port: 0,
        upstreamOrigin,
        verdictDisabled: true,
        verdictModel: "claude-test",
      },
    });
    servers.push(proxy);

    const response = await request(serverOrigin(proxy), "/health", { method: "GET" });

    expect(response.statusCode).toBe(404);
    expect(response.body).toContain("/v1/*");
  });
});

function createServer(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(serverOrigin(server)));
  });
}

function serverOrigin(server: http.Server): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected server address.");
  }

  return `http://127.0.0.1:${address.port}`;
}

async function request(
  origin: string,
  pathname: string,
  options: {
    body?: string;
    headers?: http.OutgoingHttpHeaders;
    method: string;
  },
): Promise<{ body: string; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, origin);
    const req = http.request(
      url,
      {
        headers: options.headers,
        method: options.method,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            statusCode: response.statusCode ?? 0,
          });
        });
      },
    );

    req.on("error", reject);
    req.end(options.body);
  });
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function waitForSessionLog(logDir: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const entries = (await readdir(logDir)).filter((entry) => entry.endsWith(".jsonl"));
    if (entries.length > 0) {
      const raw = await readFile(path.join(logDir, entries[0]), "utf8");
      if (raw.includes('"type":"session_end"')) {
        return raw;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for session log.");
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

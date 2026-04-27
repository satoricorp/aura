import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import type { ClipboardRunner } from "./clipboard";
import { copyToClipboard } from "./clipboard";
import { SessionCapture, isMessageStopEvent } from "./capture";
import type { ProxyConfig } from "./config";
import { renderSteeringPrompt } from "./render";
import { rotateOldSessionLogs, SessionLog } from "./session-log";
import { evaluateToolSteering } from "./steering";
import { generateAndPrintVerdict } from "./verdict";

export interface StartProxyServerOptions {
  clipboardRunner?: ClipboardRunner;
  config: ProxyConfig;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  stdout?: Pick<NodeJS.WriteStream, "write"> & { isTTY?: boolean };
}

export async function startProxyServer(options: StartProxyServerOptions): Promise<http.Server> {
  await rotateOldSessionLogs(options.config.logDir);

  const server = http.createServer((request, response) => {
    void handleProxyRequest(request, response, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.config.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  options.stderr?.write(`Aura proxy listening on http://localhost:${options.config.port}\n`);
  return server;
}

async function handleProxyRequest(
  clientRequest: IncomingMessage,
  clientResponse: ServerResponse,
  options: StartProxyServerOptions,
): Promise<void> {
  if (!clientRequest.url?.startsWith("/v1/")) {
    clientResponse.writeHead(404, { "content-type": "text/plain" });
    clientResponse.end("Aura only proxies /v1/* requests.\n");
    return;
  }

  const requestBody = await readBody(clientRequest);
  const upstream = new URL(clientRequest.url, options.config.upstreamOrigin);
  const requestId = `req_${randomUUID().slice(0, 8)}`;
  const isMessagesRequest = upstream.pathname === "/v1/messages";
  const parsedRequestBody = parseJson(requestBody);
  const sessionLog = isMessagesRequest
    ? new SessionLog(options.config.logDir, requestId)
    : undefined;
  const capture =
    sessionLog && parsedRequestBody
      ? new SessionCapture(requestId, parsedRequestBody, sessionLog.filePath)
      : undefined;

  if (sessionLog && capture) {
    await sessionLog.append("request", capture.requestMetadata);
  }

  options.stderr?.write(`${clientRequest.method ?? "GET"} ${upstream.pathname}\n`);

  const upstreamRequest = createUpstreamRequest(
    upstream,
    clientRequest,
    requestBody,
    (upstreamResponse) => {
      const chunks: Buffer[] = [];
      const heldEvents: unknown[] = [];
      const logWrites: Promise<void>[] = [];
      let nextContentBlockIndex = 0;
      let sawMessageStop = false;
      const isStreaming = isEventStream(upstreamResponse.headers["content-type"]);
      const isEncodedStream = isStreaming && Boolean(upstreamResponse.headers["content-encoding"]);
      clientResponse.writeHead(
        upstreamResponse.statusCode ?? 502,
        isStreaming ? withoutContentLength(upstreamResponse.headers) : upstreamResponse.headers,
      );

      upstreamResponse.on("data", (chunk: Buffer) => {
        chunks.push(chunk);

        if (!capture || !sessionLog || !isStreaming || isEncodedStream) {
          clientResponse.write(chunk);
          return;
        }

        for (const event of capture.observeSseChunk(chunk)) {
          nextContentBlockIndex = Math.max(nextContentBlockIndex, getEventIndex(event) + 1);
          logWrites.push(sessionLog.append("response_event", event));

          if (shouldHoldFinalEvent(event)) {
            if (isMessageStopEvent(event)) {
              sawMessageStop = true;
            }
            heldEvents.push(event);
            continue;
          }

          clientResponse.write(serializeSseEvent(event));
        }
      });

      upstreamResponse.on("end", () => {
        void (async () => {
          const renderedVerdict = await finalizeCapture({
            capture,
            chunks,
            config: options.config,
            headers: clientRequest.headers,
            isStreaming,
            logWrites,
            sawMessageStop,
            sessionLog,
            statusCode: upstreamResponse.statusCode ?? 0,
            clipboardRunner: options.clipboardRunner,
            stderr: options.stderr,
            stdout: options.stdout,
          });

          if (isStreaming && renderedVerdict) {
            clientResponse.write(serializeSseEvent(createVerdictBlockStart(nextContentBlockIndex)));
            clientResponse.write(
              serializeSseEvent(createVerdictBlockDelta(nextContentBlockIndex, renderedVerdict)),
            );
            clientResponse.write(serializeSseEvent(createVerdictBlockStop(nextContentBlockIndex)));
          }

          for (const event of heldEvents) {
            clientResponse.write(serializeSseEvent(event));
          }

          clientResponse.end();
        })().catch((error) => {
          if (!clientResponse.destroyed) {
            clientResponse.destroy(error);
          }
        });
      });
    },
  );

  upstreamRequest.on("error", (error) => {
    if (!clientResponse.headersSent) {
      clientResponse.writeHead(502, { "content-type": "text/plain" });
    }
    clientResponse.end(`Aura proxy error: ${error.message}\n`);
  });

  upstreamRequest.end(requestBody);
}

function createUpstreamRequest(
  upstream: URL,
  clientRequest: IncomingMessage,
  requestBody: Buffer,
  onResponse: (response: IncomingMessage) => void,
): http.ClientRequest {
  const headers = {
    ...clientRequest.headers,
    "accept-encoding": "identity",
    host: upstream.host,
  };
  const transport = upstream.protocol === "https:" ? https : http;

  return transport.request(
    {
      headers,
      hostname: upstream.hostname,
      method: clientRequest.method,
      path: `${upstream.pathname}${upstream.search}`,
      port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
      protocol: upstream.protocol,
    },
    onResponse,
  );
}

async function finalizeCapture(input: {
  capture?: SessionCapture;
  chunks: Buffer[];
  config: ProxyConfig;
  headers: IncomingMessage["headers"];
  isStreaming: boolean;
  logWrites: Promise<void>[];
  sawMessageStop: boolean;
  sessionLog?: SessionLog;
  statusCode: number;
  clipboardRunner?: ClipboardRunner;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  stdout?: Pick<NodeJS.WriteStream, "write"> & { isTTY?: boolean };
}): Promise<string | null> {
  if (!input.capture || !input.sessionLog || input.statusCode < 200 || input.statusCode >= 300) {
    return null;
  }

  if (!input.isStreaming) {
    const body = Buffer.concat(input.chunks);
    input.capture.observeNonStreamingResponse(body);
    const parsed = parseJson(body);
    if (parsed) {
      input.logWrites.push(input.sessionLog.append("response_event", parsed));
    }
  }

  await Promise.allSettled(input.logWrites);
  if (!input.isStreaming || input.sawMessageStop) {
    const summary = input.capture.toSummary();
    await input.sessionLog.append("session_end", {
      input_tokens: summary.inputTokens,
      output_tokens: summary.outputTokens,
      request_id: summary.requestId,
    });

    if (summary.stopReason === "tool_use") {
      await surfaceToolSteering({
        clipboardDisabled: input.config.clipboardDisabled,
        clipboardRunner: input.clipboardRunner,
        originalTask: summary.originalTask,
        stderr: input.stderr,
        toolCalls: summary.proposedToolCalls,
      });
      return null;
    }

    if (!input.config.verdictDisabled && shouldGenerateVerdict(summary)) {
      return generateAndPrintVerdict({
        appendVerdict: (verdict) => input.sessionLog!.append("verdict", verdict),
        clipboardDisabled: input.config.clipboardDisabled,
        clipboardRunner: input.clipboardRunner,
        headers: input.headers,
        injected: input.isStreaming,
        model: input.config.verdictModel,
        stderr: input.stderr,
        stdout: input.stdout,
        summary,
        upstreamOrigin: input.config.upstreamOrigin,
      });
    }
  }

  return null;
}

async function surfaceToolSteering(input: {
  clipboardDisabled: boolean;
  clipboardRunner?: ClipboardRunner;
  originalTask: string;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  toolCalls: ReturnType<SessionCapture["toSummary"]>["proposedToolCalls"];
}): Promise<void> {
  const decision = evaluateToolSteering({
    originalTask: input.originalTask,
    toolCalls: input.toolCalls,
  });

  if (decision.action === "allow") {
    return;
  }

  if (decision.action === "warn") {
    input.stderr?.write(`Aura steering warning: ${decision.message}\n`);
    return;
  }

  const prompt = renderSteeringPrompt({
    message: decision.prompt,
    reason: decision.reason,
    task: input.originalTask,
  });

  if (!input.clipboardDisabled) {
    const result = await copyToClipboard(prompt, {
      runner: input.clipboardRunner,
    });
    if (result.copied) {
      input.stderr?.write("Aura copied steering prompt to clipboard.\n");
      return;
    }

    input.stderr?.write(
      `Aura could not copy steering prompt to clipboard${result.error ? `: ${result.error}` : ""}.\n`,
    );
  }

  input.stderr?.write(`${prompt}\n`);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function parseJson(body: Buffer): unknown | null {
  if (body.length === 0) {
    return null;
  }

  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function isEventStream(contentType: string | string[] | undefined): boolean {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return value?.toLowerCase().includes("text/event-stream") ?? false;
}

function shouldGenerateVerdict(summary: {
  finalAssistantText: string;
  originalTask: string;
  reviewable: boolean;
  stopReason?: string;
}): boolean {
  const finalText = summary.finalAssistantText.trim();
  if (!summary.reviewable || !finalText || isClaudeMetadataResponse(finalText)) {
    return false;
  }

  return summary.stopReason !== "tool_use";
}

function isClaudeMetadataResponse(finalText: string): boolean {
  const normalized = finalText.toLowerCase();
  return normalized.startsWith("※ recap:") || normalized.includes("disable recaps in /config");
}

function shouldHoldFinalEvent(event: unknown): boolean {
  if (!isRecord(event) || typeof event.type !== "string") {
    return false;
  }

  return event.type === "message_delta" || event.type === "message_stop";
}

function getEventIndex(event: unknown): number {
  if (!isRecord(event) || typeof event.index !== "number") {
    return -1;
  }

  return event.index;
}

function serializeSseEvent(event: unknown): string {
  const eventName =
    isRecord(event) && typeof event.type === "string" ? `event: ${event.type}\n` : "";
  return `${eventName}data: ${JSON.stringify(event)}\n\n`;
}

function createVerdictBlockStart(index: number): Record<string, unknown> {
  return {
    type: "content_block_start",
    index,
    content_block: {
      type: "text",
      text: "",
    },
  };
}

function createVerdictBlockDelta(index: number, verdict: string): Record<string, unknown> {
  return {
    type: "content_block_delta",
    index,
    delta: {
      type: "text_delta",
      text: `\n\n${verdict}`,
    },
  };
}

function createVerdictBlockStop(index: number): Record<string, unknown> {
  return {
    type: "content_block_stop",
    index,
  };
}

function withoutContentLength(headers: IncomingMessage["headers"]): IncomingMessage["headers"] {
  const next = { ...headers };
  delete next["content-length"];
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

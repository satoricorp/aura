import type { CapturedChange, CapturedToolCall, SessionSummary } from "./types";

interface ContentBlockState {
  inputJson: string;
  name?: string;
  text: string;
  type?: string;
}

export class SessionCapture {
  private readonly blocks = new Map<number, ContentBlockState>();
  private readonly requestBody: Record<string, unknown>;
  private finalAssistantText = "";
  private inputTokens = 0;
  private outputTokens = 0;
  private readonly proposedToolCalls: CapturedToolCall[] = [];
  private sseBuffer = "";
  private stopReason: string | undefined;
  private readonly toolCalls: CapturedToolCall[];

  constructor(
    private readonly requestId: string,
    requestBody: unknown,
    private readonly sessionLogPath: string,
  ) {
    this.requestBody = isRecord(requestBody) ? requestBody : {};
    this.toolCalls = extractRequestToolCalls(this.requestBody);
  }

  get requestMetadata(): Record<string, unknown> {
    return {
      max_tokens: this.requestBody.max_tokens,
      messages: this.requestBody.messages,
      model: this.requestBody.model,
      system: this.requestBody.system,
      tool_choice: this.requestBody.tool_choice,
      tools: this.requestBody.tools,
    };
  }

  observeSseChunk(chunk: Buffer): unknown[] {
    this.sseBuffer += chunk.toString("utf8");
    const events: unknown[] = [];

    while (true) {
      const separator = findSseSeparator(this.sseBuffer);
      if (!separator) {
        break;
      }

      const rawEvent = this.sseBuffer.slice(0, separator.index);
      this.sseBuffer = this.sseBuffer.slice(separator.index + separator.length);
      const event = parseSseEvent(rawEvent);
      if (!event) {
        continue;
      }

      events.push(event);
      this.observeResponseEvent(event);
    }

    return events;
  }

  observeNonStreamingResponse(body: Buffer): void {
    try {
      const parsed = JSON.parse(body.toString("utf8")) as unknown;
      this.observeResponseMessage(parsed);
    } catch {
      // The proxy still forwards opaque responses; failed capture should not break traffic.
    }
  }

  toSummary(): SessionSummary {
    return {
      finalAssistantText: this.finalAssistantText.trim(),
      filesTouched: extractFilesTouched(this.toolCalls),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      originalTask: extractOriginalTask(this.requestBody),
      proposedToolCalls: this.proposedToolCalls,
      reviewable: isReviewableCodingRequest(this.requestBody),
      requestId: this.requestId,
      sessionLogPath: this.sessionLogPath,
      stopReason: this.stopReason,
      toolCalls: this.toolCalls,
    };
  }

  private observeResponseEvent(event: unknown): void {
    if (!isRecord(event) || typeof event.type !== "string") {
      return;
    }

    if (event.type === "content_block_start") {
      this.observeContentBlockStart(event);
      return;
    }

    if (event.type === "content_block_delta") {
      this.observeContentBlockDelta(event);
      return;
    }

    if (event.type === "content_block_stop") {
      this.observeContentBlockStop(event);
      return;
    }

    if (event.type === "message_delta") {
      if (isRecord(event.delta) && typeof event.delta.stop_reason === "string") {
        this.stopReason = event.delta.stop_reason;
      }

      if (isRecord(event.usage)) {
        this.outputTokens = numberValue(event.usage.output_tokens, this.outputTokens);
      }
      return;
    }

    if (event.type === "message_start" && isRecord(event.message)) {
      this.observeUsage(event.message.usage);
    }
  }

  private observeResponseMessage(message: unknown): void {
    if (!isRecord(message)) {
      return;
    }

    this.observeUsage(message.usage);
    if (typeof message.stop_reason === "string") {
      this.stopReason = message.stop_reason;
    }

    const content = Array.isArray(message.content) ? message.content : [];
    const text: string[] = [];

    for (const block of content) {
      if (!isRecord(block) || typeof block.type !== "string") {
        continue;
      }

      if (block.type === "text" && typeof block.text === "string") {
        text.push(block.text);
      }

      if (block.type === "tool_use" && typeof block.name === "string") {
        this.addProposedToolCall(block.name, block.input);
      }
    }

    this.finalAssistantText = text.join("\n");
  }

  private observeContentBlockStart(event: Record<string, unknown>): void {
    const index = numberValue(event.index, -1);
    if (index < 0 || !isRecord(event.content_block)) {
      return;
    }

    const block = event.content_block;
    const state: ContentBlockState = {
      inputJson: "",
      name: typeof block.name === "string" ? block.name : undefined,
      text: typeof block.text === "string" ? block.text : "",
      type: typeof block.type === "string" ? block.type : undefined,
    };

    if (isRecord(block.input) && Object.keys(block.input).length > 0) {
      state.inputJson = JSON.stringify(block.input);
    }

    this.blocks.set(index, state);
  }

  private observeContentBlockDelta(event: Record<string, unknown>): void {
    const index = numberValue(event.index, -1);
    const state = this.blocks.get(index);
    if (!state || !isRecord(event.delta)) {
      return;
    }

    const delta = event.delta;
    if (typeof delta.text === "string") {
      state.text += delta.text;
      return;
    }

    if (typeof delta.partial_json === "string") {
      state.inputJson += delta.partial_json;
    }
  }

  private observeContentBlockStop(event: Record<string, unknown>): void {
    const index = numberValue(event.index, -1);
    const state = this.blocks.get(index);
    if (!state) {
      return;
    }

    if (state.type === "text") {
      this.finalAssistantText += state.text;
    }

    if (state.type === "tool_use" && state.name) {
      const input = parseJsonOrString(state.inputJson);
      this.addProposedToolCall(state.name, input);
    }

    this.blocks.delete(index);
  }

  private observeUsage(usage: unknown): void {
    if (!isRecord(usage)) {
      return;
    }

    this.inputTokens = numberValue(usage.input_tokens, this.inputTokens);
    this.outputTokens = numberValue(usage.output_tokens, this.outputTokens);
  }

  private addProposedToolCall(toolName: string, input: unknown): void {
    const call = {
      tool_name: toolName,
      input,
      summary: summarizeToolCall(toolName, input),
    };
    this.proposedToolCalls.push(call);
    this.toolCalls.push(call);
  }
}

export function isMessageStopEvent(event: unknown): boolean {
  return isRecord(event) && event.type === "message_stop";
}

export function extractFilesTouched(toolCalls: CapturedToolCall[]): CapturedChange[] {
  const changes = new Map<string, CapturedChange>();

  for (const call of toolCalls) {
    for (const filePath of extractFilePaths(call.input)) {
      if (!changes.has(filePath)) {
        changes.set(filePath, {
          action: inferAction(call.tool_name),
          note: `${call.tool_name} referenced this path`,
          path: filePath,
        });
      }
    }
  }

  return [...changes.values()];
}

export function extractOriginalTask(requestBody: Record<string, unknown>): string {
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  const firstUser = messages.find((message) => isRecord(message) && message.role === "user");

  if (!isRecord(firstUser)) {
    return "";
  }

  return stringifyContent(firstUser.content);
}

function isReviewableCodingRequest(requestBody: Record<string, unknown>): boolean {
  const task = extractOriginalTask(requestBody).trim().toLowerCase();
  if (!task || task === "quota" || isAuraDiagnosticTask(task)) {
    return false;
  }

  const systemText = stringifySystem(requestBody.system).toLowerCase();
  const metadataPromptMarkers = [
    "generate a concise, sentence-case title",
    'return json with a single "title" field',
    "conversation summary",
    "summarize the conversation",
    "recap",
  ];

  return !metadataPromptMarkers.some((marker) => systemText.includes(marker));
}

function isAuraDiagnosticTask(task: string): boolean {
  return (
    task.startsWith("/aura-") ||
    task.includes("`aura slash discrepancies`") ||
    task.includes("`aura slash risks`") ||
    task.includes("`aura slash next`")
  );
}

function stringifySystem(system: unknown): string {
  if (typeof system === "string") {
    return system;
  }

  return stringifyContent(system);
}

function extractRequestToolCalls(requestBody: Record<string, unknown>): CapturedToolCall[] {
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  const calls: CapturedToolCall[] = [];

  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) {
      continue;
    }

    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string") {
        continue;
      }

      calls.push({
        tool_name: block.name,
        input: block.input,
        summary: summarizeToolCall(block.name, block.input),
      });
    }
  }

  return calls;
}

function parseSseEvent(rawEvent: string): unknown | null {
  const data = rawEvent
    .split(/\r?\n/)
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");

  if (!data || data === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

function findSseSeparator(buffer: string): { index: number; length: number } | null {
  const lfIndex = buffer.indexOf("\n\n");
  const crlfIndex = buffer.indexOf("\r\n\r\n");

  if (lfIndex < 0 && crlfIndex < 0) {
    return null;
  }

  if (lfIndex >= 0 && (crlfIndex < 0 || lfIndex < crlfIndex)) {
    return { index: lfIndex, length: 2 };
  }

  return { index: crlfIndex, length: 4 };
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }

      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        return block.text;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function summarizeToolCall(toolName: string, input: unknown): string {
  const paths = extractFilePaths(input);
  return paths.length > 0 ? `${toolName} ${paths.join(", ")}` : `${toolName}()`;
}

function extractFilePaths(input: unknown): string[] {
  const paths = new Set<string>();
  collectFilePaths(input, paths);
  return [...paths];
}

function collectFilePaths(value: unknown, paths: Set<string>): void {
  if (typeof value === "string") {
    if (looksLikePath(value)) {
      paths.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectFilePaths(item, paths);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (isPathKey(key) && typeof nestedValue === "string") {
      paths.add(nestedValue);
    } else {
      collectFilePaths(nestedValue, paths);
    }
  }
}

function inferAction(toolName: string): CapturedChange["action"] {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("delete") || normalized.includes("remove")) {
    return "deleted";
  }

  if (normalized.includes("write") || normalized.includes("create")) {
    return "created";
  }

  return "modified";
}

function isPathKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === "path" || normalized.endsWith("_path") || normalized.includes("file");
}

function looksLikePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    /^[\w.-]+\/[\w./-]+$/.test(value)
  );
}

function parseJsonOrString(value: string): unknown {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

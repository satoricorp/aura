export type SessionLogEntryType = "request" | "response_event" | "session_end" | "verdict";

export interface SessionLogEntry {
  ts: string;
  type: SessionLogEntryType;
  data: unknown;
}

export interface CapturedToolCall {
  tool_name: string;
  input: unknown;
  summary: string;
}

export interface CapturedChange {
  action: "created" | "deleted" | "modified";
  note: string;
  path: string;
}

export interface Verdict {
  status: "APPROVED" | "REVIEW" | "STOP";
  summary: string;
  task_understanding: string;
  changes: CapturedChange[];
  risks: string[];
  claimed_vs_actual: string[];
  next_step: string;
}

export interface SessionSummary {
  finalAssistantText: string;
  filesTouched: CapturedChange[];
  inputTokens: number;
  outputTokens: number;
  originalTask: string;
  proposedToolCalls: CapturedToolCall[];
  reviewable: boolean;
  requestId: string;
  sessionLogPath: string;
  stopReason?: string;
  toolCalls: CapturedToolCall[];
}

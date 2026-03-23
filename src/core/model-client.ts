import type { AuraConfig, ModelProvider } from "./config";

export interface JsonGenerationRequest {
  system: string;
  prompt: string;
}

export interface ModelClient {
  generateJson<T>(request: JsonGenerationRequest): Promise<T>;
}

interface OpenAiResponse {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
}

interface AnthropicResponse {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
}

export function createModelClient(
  config: AuraConfig,
  fetchImpl: typeof fetch = fetch,
): ModelClient {
  return {
    async generateJson<T>(request: JsonGenerationRequest): Promise<T> {
      let lastError: unknown;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const raw = await generateText(
            config.model.provider,
            config.model.model,
            request,
            fetchImpl,
          );
          return parseJsonResponse<T>(raw);
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
  };
}

async function generateText(
  provider: ModelProvider,
  model: string,
  request: JsonGenerationRequest,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (provider === "openai") {
    return callOpenAi(model, request, fetchImpl);
  }

  if (provider === "anthropic") {
    return callAnthropic(model, request, fetchImpl);
  }

  throw new Error(`Unsupported model provider "${provider}".`);
}

async function callOpenAi(
  model: string,
  request: JsonGenerationRequest,
  fetchImpl: typeof fetch,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required to generate Aura annotations.");
  }

  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: request.system,
      input: request.prompt,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed with ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as OpenAiResponse;
  const output = payload.output_text ?? flattenOpenAiOutput(payload);
  if (!output) {
    throw new Error("OpenAI response did not contain output text.");
  }

  return output;
}

async function callAnthropic(
  model: string,
  request: JsonGenerationRequest,
  fetchImpl: typeof fetch,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required to generate Aura annotations.");
  }

  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system: request.system,
      messages: [
        {
          role: "user",
          content: request.prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic request failed with ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as AnthropicResponse;
  const output = payload.content
    ?.filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join("\n");

  if (!output) {
    throw new Error("Anthropic response did not contain text content.");
  }

  return output;
}

function flattenOpenAiOutput(payload: OpenAiResponse): string {
  return (
    payload.output
      ?.flatMap((entry) => entry.content ?? [])
      .filter((part) => part.type === "output_text" || typeof part.text === "string")
      .map((part) => part.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n") ?? ""
  );
}

function parseJsonResponse<T>(value: string): T {
  const stripped = stripMarkdownCodeFence(value);

  try {
    return JSON.parse(stripped) as T;
  } catch (error) {
    throw new Error(
      `Model response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function stripMarkdownCodeFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  const lines = trimmed.split("\n");
  if (lines.length < 3) {
    return trimmed;
  }

  return lines.slice(1, -1).join("\n").trim();
}

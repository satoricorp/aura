import { describe, expect, test } from "bun:test";
import {
  parseAnnotation,
  parseMetadata,
  serializeAnnotation,
  serializeMetadata,
} from "../src/core/agent-schema";

describe("agent schema helpers", () => {
  test("round-trips annotations with empty collections", () => {
    const annotation = {
      id: "support-bot",
      description: "Handles customer support.",
      systemPrompt: "Be kind.\nStay concise.",
      tools: [],
      endpoints: [],
      subagents: [],
    };

    const serialized = serializeAnnotation(annotation);
    const parsed = parseAnnotation(serialized);

    expect(parsed).toEqual(annotation);
  });

  test("round-trips metadata", () => {
    const metadata = { model: "gpt-5.2" };

    expect(parseMetadata(serializeMetadata(metadata))).toEqual(metadata);
  });
});

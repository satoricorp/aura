import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, createConfig } from "../src/core/config";

describe("createConfig", () => {
  test("uses OpenAI GPT-5.2 as the default model", () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      model: {
        provider: "openai",
        model: "gpt-5.2",
      },
    });

    expect(createConfig()).toMatchObject({
      model: {
        provider: "openai",
        model: "gpt-5.2",
      },
    });
  });
});

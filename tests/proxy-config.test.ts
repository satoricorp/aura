import { describe, expect, test } from "bun:test";
import { loadProxyConfig } from "../src/core/proxy/config";

describe("loadProxyConfig", () => {
  test("enables clipboard by default", () => {
    expect(loadProxyConfig({}).clipboardDisabled).toBe(false);
  });

  test("supports disabling clipboard continuation prompts", () => {
    expect(loadProxyConfig({ AURA_DISABLE_CLIPBOARD: "1" }).clipboardDisabled).toBe(true);
  });
});

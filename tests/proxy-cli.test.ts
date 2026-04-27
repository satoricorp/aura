import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "../src/cli/index";
import { installAnthropicBaseUrl } from "../src/cli/commands/proxy";
import type { ProxyConfig } from "../src/core/proxy/config";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("proxy CLI commands", () => {
  test("init prints shell setup without requiring auth", async () => {
    let started = false;
    const output = await captureConsole(async () => {
      await main(["init"], process.cwd(), {
        installAnthropicBaseUrl: async () => ({
          changed: true,
          configPath: "/tmp/.zshrc",
          snippet: "export ANTHROPIC_BASE_URL=http://localhost:9999",
        }),
        loadProxyConfig: () => createConfig({ port: 9999 }),
        readVersion: async () => "1.2.3",
        startProxyServer: async () => {
          started = true;
          return {} as never;
        },
      });
    });

    expect(output).toContain("Updated: /tmp/.zshrc");
    expect(output).toContain("export ANTHROPIC_BASE_URL=http://localhost:9999");
    expect(output).toContain("Open a new terminal and run your coding agent.");
    expect(started).toBe(true);
  });

  test("init installer appends the shell config idempotently", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "aura-init-"));
    tempDirectories.push(home);

    const first = await installAnthropicBaseUrl("/bin/zsh", 8787, home);
    const second = await installAnthropicBaseUrl("/bin/zsh", 8787, home);
    const contents = await readFile(path.join(home, ".zshrc"), "utf8");

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(contents.match(/ANTHROPIC_BASE_URL/g)).toHaveLength(1);
    expect(contents).toContain("export ANTHROPIC_BASE_URL=http://localhost:8787");
  });

  test("status reads the most recent verdicts", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "aura-status-"));
    tempDirectories.push(logDir);
    await writeFile(
      path.join(logDir, "2026-04-26T00-00-00-000Z-req_test.jsonl"),
      `${JSON.stringify({
        ts: "2026-04-26T00:00:00.000Z",
        type: "verdict",
        data: { status: "APPROVED", summary: "All good" },
      })}\n`,
    );

    const output = await captureConsole(async () => {
      await main(["status"], process.cwd(), {
        loadProxyConfig: () => createConfig({ logDir }),
        readVersion: async () => "1.2.3",
      });
    });

    expect(output).toContain("Recent Aura verdicts");
    expect(output).toContain("APPROVED");
    expect(output).toContain("All good");
  });

  test("start applies --port before starting the proxy", async () => {
    let observedInstallPort = 0;
    let observedPort = 0;

    await main(["start", "--port", "9998"], process.cwd(), {
      installAnthropicBaseUrl: async (_shell, port) => {
        observedInstallPort = port ?? 0;
        return {
          changed: false,
          configPath: "/tmp/.zshrc",
          snippet: `export ANTHROPIC_BASE_URL=http://localhost:${port}`,
        };
      },
      loadProxyConfig: () => createConfig({ port: 8787 }),
      readVersion: async () => "1.2.3",
      startProxyServer: async ({ config }) => {
        observedPort = config.port;
        return {} as never;
      },
    });

    expect(observedInstallPort).toBe(9998);
    expect(observedPort).toBe(9998);
  });
});

function createConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    logDir: "/tmp/aura/sessions",
    port: 8787,
    upstreamOrigin: "http://127.0.0.1:1",
    verdictDisabled: true,
    verdictModel: "claude-test",
    ...overrides,
  };
}

async function captureConsole(run: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  const calls: string[] = [];
  console.log = (...args: unknown[]) => {
    calls.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
  }

  return calls.join("\n");
}

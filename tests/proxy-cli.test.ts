import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "../src/cli/index";
import { installAnthropicBaseUrl, installClaudeSlashCommands } from "../src/cli/commands/proxy";
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
        installClaudeSlashCommands: async () => ({
          changed: ["/aura-risks"],
          commandsDir: "/tmp/.claude/commands",
          unchanged: [],
        }),
        readVersion: async () => "1.2.3",
        startProxyServer: async () => {
          started = true;
          return {} as never;
        },
      });
    });

    expect(output).toContain("Updated: /tmp/.zshrc");
    expect(output).toContain("export ANTHROPIC_BASE_URL=http://localhost:9999");
    expect(output).toContain("Claude Code slash commands");
    expect(output).toContain("/aura-risks");
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

  test("Claude slash command installer writes command files idempotently", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "aura-claude-"));
    tempDirectories.push(home);

    const first = await installClaudeSlashCommands(home);
    const second = await installClaudeSlashCommands(home);
    const risks = await readFile(path.join(home, ".claude", "commands", "aura-risks.md"), "utf8");

    expect(first.changed).toContain("/aura-risks");
    expect(second.changed).toHaveLength(0);
    expect(second.unchanged).toContain("/aura-risks");
    expect(risks).toContain("aura slash risks");
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

  test("sessions lists captured session verdicts", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "aura-sessions-"));
    tempDirectories.push(logDir);
    await writeSessionLog(logDir);

    const output = await captureConsole(async () => {
      await main(["sessions"], process.cwd(), {
        loadProxyConfig: () => createConfig({ logDir }),
        readVersion: async () => "1.2.3",
      });
    });

    expect(output).toContain("Recent Aura sessions");
    expect(output).toContain("req_test");
    expect(output).toContain("REVIEW");
    expect(output).toContain("Tests were not run");
  });

  test("slash discrepancies prints prompt-ready context", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "aura-slash-"));
    tempDirectories.push(logDir);
    await writeSessionLog(logDir);

    const output = await captureConsole(async () => {
      await main(["slash", "discrepancies"], process.cwd(), {
        loadProxyConfig: () => createConfig({ logDir }),
        readVersion: async () => "1.2.3",
      });
    });

    expect(output).toContain("Review Aura's discrepancies");
    expect(output).toContain("Session: req_test");
    expect(output).toContain("- Agent claimed tests passed, but no test command was observed.");
  });

  test("slash next prints the latest suggested next step", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "aura-slash-"));
    tempDirectories.push(logDir);
    await writeSessionLog(logDir);

    const output = await captureConsole(async () => {
      await main(["slash", "next"], process.cwd(), {
        loadProxyConfig: () => createConfig({ logDir }),
        readVersion: async () => "1.2.3",
      });
    });

    expect(output).toContain("Continue from Aura's suggested next step");
    expect(output).toContain("Next step: Run the missing tests.");
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
      installClaudeSlashCommands: async () => ({
        changed: [],
        commandsDir: "/tmp/.claude/commands",
        unchanged: ["/aura-discrepancies", "/aura-risks", "/aura-next"],
      }),
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
    clipboardDisabled: true,
    logDir: "/tmp/aura/sessions",
    port: 8787,
    upstreamOrigin: "http://127.0.0.1:1",
    verdictDisabled: true,
    verdictModel: "claude-test",
    ...overrides,
  };
}

async function writeSessionLog(logDir: string): Promise<void> {
  await writeFile(
    path.join(logDir, "2026-04-26T00-00-00-000Z-req_test.jsonl"),
    [
      JSON.stringify({
        ts: "2026-04-26T00:00:00.000Z",
        type: "session_end",
        data: { request_id: "req_test", input_tokens: 10, output_tokens: 20 },
      }),
      JSON.stringify({
        ts: "2026-04-26T00:00:01.000Z",
        type: "verdict",
        data: {
          status: "REVIEW",
          summary: "Tests were not run",
          task_understanding: "Update parser",
          changes: [],
          risks: ["Missing verification."],
          claimed_vs_actual: ["Agent claimed tests passed, but no test command was observed."],
          next_step: "Run the missing tests.",
        },
      }),
      "",
    ].join("\n"),
  );
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

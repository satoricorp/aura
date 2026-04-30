# aura

CLI that proxies Anthropic API calls, with auth and analytics.

## Install

```bash
npm install -g aura
```

## How it works

Aura runs a local HTTP proxy on `localhost:8787` that sits between your coding agent and the Anthropic API. It captures every request and response, logs them to `~/.aura/sessions/`, and after each completed session generates a short verdict summarizing what the agent did and whether it succeeded.

Point your tool at the proxy by setting `ANTHROPIC_BASE_URL`:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
```

`aura init` writes this to your shell config automatically. Run `aura start` in a dedicated terminal, then use Claude Code or any Anthropic-compatible client as normal.

## Commands

| Command                 | Description                           |
| ----------------------- | ------------------------------------- |
| `aura init`             | Configure shell and start the proxy   |
| `aura start [--port N]` | Start the proxy server                |
| `aura status`           | Show proxy status and recent requests |
| `aura login`            | Authenticate with Aura                |
| `aura logout`           | Remove saved session                  |
| `aura whoami`           | Show current auth state               |
| `aura version`          | Print CLI version                     |

## Environment variables

| Variable               | Default                     | Description                                   |
| ---------------------- | --------------------------- | --------------------------------------------- |
| `AURA_PORT`            | `8787`                      | Port the proxy listens on                     |
| `AURA_LOG_DIR`         | `~/.aura/sessions`          | Directory for session logs                    |
| `AURA_UPSTREAM_ORIGIN` | `https://api.anthropic.com` | Upstream API to proxy to                      |
| `AURA_VERDICT_MODEL`   | `claude-haiku-4-5-20251001` | Model used to generate verdicts               |
| `AURA_DISABLE_VERDICT` | —                           | Set to `1` to skip verdict generation         |
| `AURA_NO_UPDATES`      | —                           | Set to `1` to suppress version-check warnings |

## Development

```bash
bun install
bun run dev        # run CLI from source
bun test           # run tests
bun run build      # compile to dist/
```

Set `AURA_NO_UPDATES=1` to suppress version-check warnings.

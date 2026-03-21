# aura — Specification v0.1

---

## Overview

`aura` is an npm-published CLI that reads `aura.md`, generates reviewable TypeScript source for each agent into `/src/agents`, and uses a build step to compile deployable artifacts into `/dist`.

Each agent exposes an API, CLI, Skill, and MCP. The output is business logic you can change and save via git. Our goal is to increase determinism, with instructions to build things with specific libraries to make it more predictable.

`aura.md` is the single source of truth.

---

## Distribution

`aura` is published to npm.

```bash
npm install -g aura
aura --version
```

On every command, `aura` checks the npm registry for a newer version and warns if one is available. Suppressible with `AURA_NO_UPDATES=1`.

---

## Open Source vs Paid Split

**Open source**

- `aura generate` and everything it produces
- `src/agents` source and compiled `dist` artifacts are fully self-contained, no Satorico infrastructure required

**Paid**

- `aura deploy` and all subcommands
- @satorico handles code.storage push, npm publish for CLI, live URL

---

## The `aura.md` Format

A plain markdown file at the project root. Each level-2 heading (`##`) defines an **orchestrator agent**. Level-3+ headings define **subagents** owned by the nearest parent above them. If no subagents are defined, the orchestrator agent is a standalone agent.

```markdown
# Aura Agents

## Support Bot

Handles customer support for a SaaS product. Helps users troubleshoot billing
issues, understand features, and routes complex cases to the right place.
Should be empathetic and concise.

### Billing Agent

Specializes in billing questions, subscription changes, and payment failures.

### FAQ Agent

Answers common product questions. If it doesn't know, it escalates rather than guessing.

## Code Reviewer

Reviews pull request diffs and provides feedback on code quality and security.
Direct, specific, no vague feedback. Focused on TypeScript codebases.
```

### Heading Hierarchy

| Level   | Role                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------- |
| `#`     | File title — ignored                                                                           |
| `##`    | Orchestrator — gets its own `src/agents/<id>/` source tree, later compiled to `dist/<id>/`     |
| `###`   | Subagent — owned by nearest `##` parent, generated as a module in `src/agents/<id>/subagents/` |
| `####`+ | Sub-subagent — owned by nearest `###` parent                                                   |

Subagents are not independently deployable in v0.1. They are TypeScript modules called by their orchestrator. Only orchestrators get the four public surfaces.

---

## `aura.config.ts`

Created by `aura init`. Keep this super simple.

```typescript
import { config } from "aura";

export default config({
  model: {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
  },
  outDir: "dist",
  maxSteps: 5,
});
```

`maxSteps` controls how many tool-use iterations generated agents allow before stopping. Default: `5`. Applied globally — not configurable per-agent in v0.1.
`outDir` controls where `aura build` writes compiled artifacts. `aura generate` always writes reviewable source to `src/agents/`.

---

## Annotation Format

After extraction, `aura generate` command writes `annotation` and `metadata` blocks back into `aura.md` directly below each agent heading. These blocks are the source of truth for codegen. The user edits them directly to steer the output.

````markdown
## Support Bot

Handles customer support for a SaaS product.

```annotation
id: support-bot
description: Handles customer support for a SaaS product
systemPrompt: |
  You are a customer support agent for a SaaS product. Your primary job
  is to help users with billing issues, understand product features, and
  route complex or frustrated users to the right place. Be empathetic and
  concise. Never make promises about refunds without verification.
tools:
  - id: exa_search
    description: Web search
    requiresCredential: EXA_API_KEY
  - id: lookup_order
    description: HTTP request to internal order API to retrieve order history
endpoints:
  - method: POST
    path: /chat
    description: Streaming chat interface
    streaming: true
  - method: POST
    path: /escalate
    description: Route conversation to human support
subagents:
  - billing-agent
  - faq-agent
```

```metadata
model: claude-sonnet-4-5
```
````

Each agent and subagent gets both an `annotation` block and a `metadata` block, written immediately below the heading description.

### Rules

- `annotation` contains the extracted agent structure — freely editable by the user
- `metadata` contains model config inherited from `aura.config.ts` — overrideable per-agent
- If blocks are already present on re-run, `aura` uses them as-is and skips re-extraction
- To force re-extraction for an agent, delete its `annotation` block and re-run
- `aura.md` is the only source of truth — no lock file

---

## Exa / Web Search

Not included by default. If the agent requires web search, the user can confirm they need Exa during the approval step. If the LLM determines the agent could benefit from web search, it proposes `exa_search` in the annotation and the terminal prompts:

```
◆ Support Bot proposes web search (exa_search). Include it? › Yes / No
```

If the user stays 'Yes', then the CLI prompts for the EXA_API_KEY, and writes it to .env in root. If there is no .env, show error, note the user needs to add the API key in their environment variables under EXA_API_KEY, and continue.

---

## Human-in-the-Loop Approval Step

No code is written until the user explicitly continues. `aura.md` is the editor — the CLI is a checkpoint only. The CLI gives a brief overview but does not print the actual annotation. It gives very brief bullet points of the endpoints and tools it wants to expose. At this point, the user can edit `aura.md` and it will re-read the annotations on continue.

### Flow

```
$ aura generate

◆ Parsing aura.md...
◆ Extracting agent definitions...
◆ Writing annotations to aura.md...

  ✔ Support Bot
      · 2 endpoints: POST /chat, POST /escalate
      · 3 tools: exa_search, lookup_order, agent_handoff
      · 2 subagents: billing-agent, faq-agent

  ✔ Code Reviewer
      · 1 endpoint: POST /review
      · 0 subagents

  ◆ Support Bot proposes web search (exa_search). Include it? › Yes / No

◆ Which surfaces do you want to generate? (select all that apply)
  ◼ API
  ◼ MCP
  ◼ CLI
  ◼ Skill

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Review and edit aura.md, then press Enter to generate.
  Press Ctrl+C to abort.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Press Enter to continue...
```

After Enter, `aura` re-reads `aura.md` and uses whatever is in the annotation blocks at that moment. A final confirmation is shown before writing any files:

```
  ⚠ src/agents/support-bot/ already exists and will be overwritten. Run `aura generate support-bot` to only generate logic for a single agent.
  ⚠ src/agents/code-reviewer/ already exists and will be overwritten. Run `aura generate code-reviewer` to only generate logic for a single agent.


  support-bot     2 endpoints · 3 tools · 2 subagents   [API, MCP, CLI, Skill]
  code-reviewer   1 endpoint  · 0 tools · 0 subagents   [API, MCP, Skill]

  Output: src/agents/
  Files:  18 new

◆ Confirm? › Yes / No
```

The overwrite warning only appears for agents whose output directory already exists.

---

## Generated Source and Build Structure

`src/agents/<agent>/{api,mcp,cli,SKILL.md}` is the reviewable source contract.
`aura build` compiles the matching deployable artifact structure into `dist/<agent>/`. Don't restructure either layout.

```
src/agents/
  <agent-name>/
    agent.ts            ← core logic, shared by all surfaces
    subagents/
      billing-agent.ts  ← subagent modules, not independently deployed
      faq-agent.ts
    api/
      index.ts          ← Hono server
      package.json
    mcp/
      index.ts          ← Hono + @hono/mcp
      package.json
    cli/
      index.ts          ← npx-runnable entrypoint
      package.json
    SKILL.md            ← generated skill definition
```

```
dist/
  <agent-name>/
    agent.js
    subagents/
      billing-agent.js
      faq-agent.js
    api/
      index.js
      package.json
    mcp/
      index.js
      package.json
    cli/
      index.js
      package.json
    SKILL.md
```

`src/agents/` is the reviewable source tree users touch. `dist/` is compiled output for deployment or publishing.

---

## The Four Surfaces

Each surface has its own `package.json` so it can be deployed or published independently. The number of endpoints, MCP tools, and CLI commands is inferred from the annotation — not a fixed template. There should be a mechanism to determine what endpoints and tools to create and expose, which is handled by the HITL approval step.

### 1. API (`src/agents/<agent>/api/`)

Hono server source. One route per endpoint in the annotation. `aura build` compiles it to `dist/<agent>/api/`.

### 2. MCP (`src/agents/<agent>/mcp/`)

Hono + `@hono/mcp`. Streamable HTTP transport only, no stdio. Tools are inferred from the annotation. `aura build` compiles it to `dist/<agent>/mcp/`.

### 3. CLI (`src/agents/<agent>/cli/`)

Standalone npm package published under `@satorico/<agent-name>`. Commands are inferred from the annotation's endpoints and intent. Generate a `chat` command only when conversational interaction supports the agent's job. Generated agent CLIs are non-interactive and do not use Clack.

`aura` does not publish CLIs in the free tier. The user runs `npm publish` from `dist/<agent>/cli/`. `aura deploy` handles publishing for paid users.

### 4. Skill (`src/agents/<agent>/SKILL.md`)

Claude skill definition source, inferred from the agent description in `aura.md`. Interfaces with the agent via the CLI — not the API directly. `aura build` copies it to `dist/<agent>/SKILL.md`.

---

## Technology Stack

Fixed. The LLM is instructed to only output TypeScript following these library choices. Do not deviate.

| Concern        | Library                                 |
| -------------- | --------------------------------------- |
| AI SDK         | `ai` (Vercel AI SDK v4+)                |
| Anthropic      | `@ai-sdk/anthropic`                     |
| OpenAI         | `@ai-sdk/openai`                        |
| HTTP framework | `hono`                                  |
| MCP transport  | `@hono/mcp` — `StreamableHTTPTransport` |
| Web search     | `exa-js`                                |
| Aura CLI       | `@clack/prompts`                        |
| Validation     | `zod`                                   |
| Language       | TypeScript                              |

### Naming Conventions

| Concept                      | Name in generated code |
| ---------------------------- | ---------------------- |
| Agent system prompt constant | `AGENT_PROMPT`         |
| Agent identifier constant    | `AGENT_ID`             |

`AGENT_PROMPT` maps to the `system` field in Vercel AI SDK calls. `SYSTEM_PROMPT` is never used.

---

## Codegen: TypeScript Compile Validation Loop

After `aura generate` writes source files to `src/agents/`, `aura` runs `tsc --noEmit` against the generated source. If there are errors, keep iterating until the bugs are fixed:

1. Feed failing files + full `tsc` output back to the LLM — fix compile errors only, don't rewrite logic
2. Overwrite affected files, re-run `tsc --noEmit`
3. After 5 failed attempts, stop, surface the error, suggest switching model in `aura.config.ts`

Silent loop — user sees a spinner and ✔ or ✗ per agent.

```
◆ Compiling support-bot...     ✔ Clean
◆ Compiling code-reviewer...   ↻ Fixing (1 iteration)...  ✔ Clean
```

---

## CLI Commands

### `aura init`

Creates `aura.config.ts` and scaffolds `aura.md`.

```
$ aura init

◆ Created aura.config.ts
◆ Created aura.md

  Edit aura.md to describe your agents, then run:
  aura generate
```

### `aura generate`

```bash
aura generate              # all agents, all surfaces
aura generate <agent>      # one agent (matches ## heading name, normalize both names to check for matches), all surfaces
aura generate <agent> api     # one agent (matches ## heading name, normalize both names to check for matches), one surface
aura generate <agent> mcp
aura generate <agent> cli
aura generate <agent> skill
aura generate --dry-run    # parse and show what would be generated, write nothing
```

Re-running always wipes and regenerates from current annotations. No incremental merge.

### `aura build`

```bash
aura build              # compile all generated agents from src/agents into dist
aura build <agent>      # one agent, all generated surfaces
aura build <agent> api  # one agent, one surface
aura build <agent> mcp
aura build <agent> cli
aura build <agent> skill
```

`aura build` compiles the generated source tree and copies non-code artifacts like `package.json` and `SKILL.md` into `dist/`.

### `aura deploy` _(paid)_

```bash
aura deploy                        # all agents, all surfaces
aura deploy <agent>                # one agent, all surfaces
aura deploy <agent> api            # one agent, one surface
aura deploy <agent> mcp
aura deploy <agent> cli
aura deploy <agent> skill
```

Uses `@pierre/storage` (code.storage TypeScript SDK) to create a repo and push the relevant `dist/<agent>/<surface>/` contents. npm publish for CLI surfaces is handled by Satorico infrastructure.

**Error: surface not generated**

```
✗ No CLI found for agent "my-agent"

  Run: aura generate my-agent
  Then re-run: aura deploy my-agent cli
```

**Error: agent not found**

```
✗ No agent "nonexistent" found

  Available agents:
    my-agent
    other-agent
```

### `aura list`

```
$ aura list

  support-bot        annotated   2 tools · 2 endpoints · 2 subagents
  └─ billing-agent   annotated   1 tool  · 1 endpoint
  └─ faq-agent       annotated   0 tools · 1 endpoint
  code-reviewer      annotated   1 tool  · 2 endpoints
```

---

## Free User Deployment (self-serve, documented in README)

```
API:   push to GitHub → connect dist/<agent>/api to Vercel → auto-deploys
MCP:   push to GitHub → connect dist/<agent>/mcp to Vercel → auto-deploys
CLI:   cd dist/<agent>/cli → npm publish
Skill: cp dist/<agent>/SKILL.md ./SKILL.md
```

---

## Error Handling

| Failure                                | Behavior                                                    |
| -------------------------------------- | ----------------------------------------------------------- |
| `aura.md` not found                    | Error, prompt to run `aura init`                            |
| `aura.config.ts` not found             | Verify `aura init` ran. Use defaults, warn user.            |
| Extraction LLM call fails              | Verify init. Retry once.                                    |
| Extraction produces invalid JSON       | Retry once. If still invalid, suggest a more capable model. |
| Codegen won't compile after 5 attempts | Surface tsc error, suggest switching model                  |
| `aura deploy` surface missing          | Show targeted error with `aura generate` instructions       |
| `aura deploy` agent not found          | List available agents                                       |
| npm update check fails                 | Silently skip — never block                                 |

---

## v0.1 Scope Boundaries

- ❌ Subagents are not independently deployable
- ❌ No inter-agent communication across different orchestrators
- ❌ No built-in memory or persistence

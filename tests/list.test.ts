import { describe, expect, test } from "bun:test";
import { parseAuraMarkdown } from "../src/core/aura-md";
import { formatAgentList } from "../src/cli/utils/format";

describe("formatAgentList", () => {
  test("renders a tree with counts and annotation state", () => {
    const document = parseAuraMarkdown(`# Aura Agents

## Support Bot
Handles customer support for a SaaS product.

\`\`\`annotation
tools:
  - id: exa_search
endpoints:
  - method: POST
    path: /chat
subagents:
  - billing-agent
\`\`\`

### Billing Agent
Handles billing issues.
`);

    const output = formatAgentList(document);

    expect(output).toContain("support-bot");
    expect(output).toContain("annotated");
    expect(output).toContain("1 tool");
    expect(output).toContain("1 endpoint");
    expect(output).toContain("1 subagent");
    expect(output).toContain("└─ billing-agent");
  });
});

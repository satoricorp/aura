import { describe, expect, test } from "bun:test";
import { parseAuraMarkdown, summarizeAnnotation, upsertManagedBlocks } from "../src/core/aura-md";

describe("parseAuraMarkdown", () => {
  test("parses hierarchy, descriptions, and managed blocks", () => {
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

\`\`\`metadata
model: gpt-5.2
\`\`\`

### Billing Agent
Handles billing questions.
`);

    expect(document.sections).toHaveLength(2);
    expect(document.sections[0]?.slug).toBe("support-bot");
    expect(document.sections[0]?.description).toBe("Handles customer support for a SaaS product.");
    expect(document.sections[0]?.annotation?.value).toContain("tools:");
    expect(document.sections[1]?.parentSlug).toBe("support-bot");
  });

  test("preserves unmanaged content when managed blocks are replaced", () => {
    const source = `# Aura Agents

## Support Bot
Handles customer support.

<!-- keep me exactly -->

\`\`\`annotation
id: old-support-bot
\`\`\`

\`\`\`metadata
model: old-model
\`\`\`

### Billing Agent
Handles billing questions.
`;

    const updated = upsertManagedBlocks(parseAuraMarkdown(source), "support-bot", {
      annotation: `id: support-bot
endpoints:
  - method: POST
    path: /chat`,
      metadata: `model: gpt-5.2`,
    });

    expect(updated).toContain("<!-- keep me exactly -->");
    expect(updated).toContain("### Billing Agent");
    expect(updated).not.toContain("id: old-support-bot");
    expect(updated).toContain("id: support-bot");
  });
});

describe("summarizeAnnotation", () => {
  test("counts top-level list items for supported sections", () => {
    const summary = summarizeAnnotation(`tools:
  - id: exa_search
  - id: lookup_order
endpoints:
  - method: POST
    path: /chat
subagents:
  - billing-agent
  - faq-agent
`);

    expect(summary).toEqual({
      tools: 2,
      endpoints: 1,
      subagents: 2,
    });
  });
});

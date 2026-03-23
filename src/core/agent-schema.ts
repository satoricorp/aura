export type SurfaceName = "api" | "mcp" | "cli" | "skill";

export interface ToolSpec {
  id: string;
  description: string;
  requiresCredential?: string;
}

export interface EndpointSpec {
  method: string;
  path: string;
  description: string;
  streaming?: boolean;
}

export interface AgentAnnotation {
  id: string;
  description: string;
  systemPrompt: string;
  tools: ToolSpec[];
  endpoints: EndpointSpec[];
  subagents: string[];
}

export interface AgentMetadata {
  model: string;
}

type YamlScalar = string | boolean;
interface YamlObject {
  [key: string]: YamlValue;
}
interface YamlArray extends Array<YamlValue> {}
type YamlValue = YamlScalar | YamlObject | YamlArray;

interface ParsedYamlLine {
  indent: number;
  text: string;
}

export function parseAnnotation(source: string): AgentAnnotation {
  const parsed = parseYamlObject(source);

  return {
    id: requireString(parsed.id, "annotation.id"),
    description: requireString(parsed.description, "annotation.description"),
    systemPrompt: requireString(parsed.systemPrompt, "annotation.systemPrompt"),
    tools: requireArray(parsed.tools, "annotation.tools").map((value, index) =>
      parseTool(value, `annotation.tools[${index}]`),
    ),
    endpoints: requireArray(parsed.endpoints, "annotation.endpoints").map((value, index) =>
      parseEndpoint(value, `annotation.endpoints[${index}]`),
    ),
    subagents: requireArray(parsed.subagents, "annotation.subagents").map((value, index) =>
      requireString(value, `annotation.subagents[${index}]`),
    ),
  };
}

export function parseMetadata(source: string): AgentMetadata {
  const parsed = parseYamlObject(source);
  return {
    model: requireString(parsed.model, "metadata.model"),
  };
}

export function serializeAnnotation(annotation: AgentAnnotation): string {
  const lines = [
    `id: ${escapeYamlString(annotation.id)}`,
    `description: ${escapeYamlString(annotation.description)}`,
    "systemPrompt: |",
    ...indentBlock(annotation.systemPrompt),
  ];

  if (annotation.tools.length === 0) {
    lines.push("tools: []");
  } else {
    lines.push("tools:", ...serializeTools(annotation.tools));
  }

  if (annotation.endpoints.length === 0) {
    lines.push("endpoints: []");
  } else {
    lines.push("endpoints:", ...serializeEndpoints(annotation.endpoints));
  }

  if (annotation.subagents.length === 0) {
    lines.push("subagents: []");
  } else {
    lines.push("subagents:", ...serializeStrings(annotation.subagents));
  }

  return `${lines.join("\n")}\n`;
}

export function serializeMetadata(metadata: AgentMetadata): string {
  return `model: ${escapeYamlString(metadata.model)}\n`;
}

export function isSurfaceName(value: string): value is SurfaceName {
  return value === "api" || value === "mcp" || value === "cli" || value === "skill";
}

function serializeTools(tools: ToolSpec[]): string[] {
  if (tools.length === 0) {
    return ["  []"];
  }

  return tools.flatMap((tool) => {
    const lines = [
      `  - id: ${escapeYamlString(tool.id)}`,
      `    description: ${escapeYamlString(tool.description)}`,
    ];

    if (tool.requiresCredential) {
      lines.push(`    requiresCredential: ${escapeYamlString(tool.requiresCredential)}`);
    }

    return lines;
  });
}

function serializeEndpoints(endpoints: EndpointSpec[]): string[] {
  if (endpoints.length === 0) {
    return ["  []"];
  }

  return endpoints.flatMap((endpoint) => {
    const lines = [
      `  - method: ${escapeYamlString(endpoint.method)}`,
      `    path: ${escapeYamlString(endpoint.path)}`,
      `    description: ${escapeYamlString(endpoint.description)}`,
    ];

    if (endpoint.streaming !== undefined) {
      lines.push(`    streaming: ${String(endpoint.streaming)}`);
    }

    return lines;
  });
}

function serializeStrings(values: string[]): string[] {
  if (values.length === 0) {
    return ["  []"];
  }

  return values.map((value) => `  - ${escapeYamlString(value)}`);
}

function escapeYamlString(value: string): string {
  if (value.length === 0) {
    return '""';
  }

  if (/^[A-Za-z0-9._/@-]+$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function indentBlock(value: string): string[] {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  return lines.map((line) => `  ${line}`);
}

function parseTool(value: YamlValue, path: string): ToolSpec {
  const object = requireObject(value, path);

  return {
    id: requireString(object.id, `${path}.id`),
    description: requireString(object.description, `${path}.description`),
    requiresCredential:
      object.requiresCredential === undefined
        ? undefined
        : requireString(object.requiresCredential, `${path}.requiresCredential`),
  };
}

function parseEndpoint(value: YamlValue, path: string): EndpointSpec {
  const object = requireObject(value, path);
  const streamingValue = object.streaming;

  return {
    method: requireString(object.method, `${path}.method`),
    path: requireString(object.path, `${path}.path`),
    description: requireString(object.description, `${path}.description`),
    streaming:
      streamingValue === undefined
        ? undefined
        : requireBoolean(streamingValue, `${path}.streaming`),
  };
}

function requireObject(value: YamlValue | undefined, path: string): YamlObject {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`Expected ${path} to be an object.`);
  }

  return value;
}

function requireArray(value: YamlValue | undefined, path: string): YamlValue[] {
  if (value === "[]") {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`Expected ${path} to be a list.`);
  }

  return value;
}

function requireString(value: YamlValue | undefined, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${path} to be a string.`);
  }

  return value;
}

function requireBoolean(value: YamlValue | undefined, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Expected ${path} to be a boolean.`);
  }

  return value;
}

function parseYamlObject(source: string): YamlObject {
  const lines = normalizeYamlLines(source);
  let index = 0;
  const value = parseBlock(
    lines,
    0,
    () => index,
    (next) => {
      index = next;
    },
  );

  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Expected a YAML object.");
  }

  return value;
}

function normalizeYamlLines(source: string): ParsedYamlLine[] {
  return source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      return {
        indent: line.length - line.trimStart().length,
        text: trimmed,
      };
    });
}

function parseBlock(
  lines: ParsedYamlLine[],
  indent: number,
  getIndex: () => number,
  setIndex: (next: number) => void,
): YamlValue {
  const current = findNextMeaningfulLine(lines, getIndex());
  if (!current) {
    return {};
  }

  if (current.line.indent < indent) {
    return {};
  }

  if (current.line.text.startsWith("- ")) {
    return parseArray(lines, indent, getIndex, setIndex);
  }

  return parseObject(lines, indent, getIndex, setIndex);
}

function parseObject(
  lines: ParsedYamlLine[],
  indent: number,
  getIndex: () => number,
  setIndex: (next: number) => void,
): YamlObject {
  const result: YamlObject = {};
  let index = getIndex();

  while (index < lines.length) {
    const current = findNextMeaningfulLine(lines, index);
    if (!current) {
      break;
    }

    index = current.index;
    const line = current.line;
    if (line.indent < indent) {
      break;
    }

    if (line.indent !== indent) {
      throw new Error(`Unexpected indentation at line ${index + 1}.`);
    }

    const separatorIndex = line.text.indexOf(":");
    if (separatorIndex === -1) {
      throw new Error(`Expected key/value pair at line ${index + 1}.`);
    }

    const key = line.text.slice(0, separatorIndex).trim();
    const remainder = line.text.slice(separatorIndex + 1).trim();
    index += 1;

    if (remainder === "|") {
      const block = parseMultilineString(lines, indent + 2, index);
      result[key] = block.value;
      index = block.nextIndex;
      continue;
    }

    if (remainder.length > 0) {
      result[key] = parseScalar(remainder);
      continue;
    }

    const nextLine = findNextMeaningfulLine(lines, index);
    if (!nextLine || nextLine.line.indent <= indent) {
      result[key] = "";
      continue;
    }

    setIndex(index);
    result[key] = parseBlock(lines, indent + 2, getIndex, setIndex);
    index = getIndex();
  }

  setIndex(index);
  return result;
}

function parseArray(
  lines: ParsedYamlLine[],
  indent: number,
  getIndex: () => number,
  setIndex: (next: number) => void,
): YamlValue[] {
  const result: YamlValue[] = [];
  let index = getIndex();

  while (index < lines.length) {
    const current = findNextMeaningfulLine(lines, index);
    if (!current) {
      break;
    }

    index = current.index;
    const line = current.line;
    if (line.indent < indent) {
      break;
    }

    if (line.indent !== indent || !line.text.startsWith("- ")) {
      break;
    }

    const remainder = line.text.slice(2).trim();
    index += 1;

    if (remainder.length === 0) {
      const nextLine = findNextMeaningfulLine(lines, index);
      if (!nextLine || nextLine.line.indent <= indent) {
        result.push("");
        continue;
      }

      setIndex(index);
      result.push(parseBlock(lines, indent + 2, getIndex, setIndex));
      index = getIndex();
      continue;
    }

    const separatorIndex = remainder.indexOf(":");
    if (separatorIndex !== -1) {
      const key = remainder.slice(0, separatorIndex).trim();
      const value = remainder.slice(separatorIndex + 1).trim();
      const entry: YamlObject = {
        [key]: value === "|" ? "" : value.length === 0 ? "" : parseScalar(value),
      };

      if (value === "|") {
        const block = parseMultilineString(lines, indent + 4, index);
        entry[key] = block.value;
        index = block.nextIndex;
      }

      const nextLine = findNextMeaningfulLine(lines, index);
      if (nextLine && nextLine.line.indent > indent) {
        setIndex(index);
        const extra = parseObject(lines, indent + 2, getIndex, setIndex);
        index = getIndex();
        Object.assign(entry, extra);
      }

      result.push(entry);
      continue;
    }

    result.push(parseScalar(remainder));
  }

  setIndex(index);
  return result;
}

function parseScalar(value: string): YamlScalar {
  if (value === "[]") {
    return "[]";
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    try {
      return JSON.parse(value.startsWith("'") ? `"${value.slice(1, -1)}"` : value);
    } catch {
      return value.slice(1, -1);
    }
  }

  return value;
}

function parseMultilineString(
  lines: ParsedYamlLine[],
  indent: number,
  startIndex: number,
): { value: string; nextIndex: number } {
  const values: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (line.text.length === 0) {
      values.push("");
      index += 1;
      continue;
    }

    if (line.indent < indent) {
      break;
    }

    values.push(" ".repeat(Math.max(0, line.indent - indent)) + line.text);
    index += 1;
  }

  return {
    value: values.join("\n").replace(/\s+$/g, ""),
    nextIndex: index,
  };
}

function findNextMeaningfulLine(
  lines: ParsedYamlLine[],
  startIndex: number,
): { index: number; line: ParsedYamlLine } | null {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.text.length > 0) {
      return { index, line };
    }
  }

  return null;
}

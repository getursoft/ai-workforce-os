/**
 * A tiny, safe (non-`eval`) boolean expression evaluator for SkillPipelineNode.conditionExpression.
 * Supports exactly one comparison of the shape `<root>.<path> <op> <literal>`, where `<root>` is
 * `output` (the previous node's result) or `trigger` (the pipeline's original input), `<path>` is a
 * dot-separated chain of object keys, `<op>` is one of == != > >= < <=, and `<literal>` is a number,
 * boolean, `null`, or a single/double-quoted string. Anything that doesn't parse into this shape
 * cannot execute arbitrary code — it only ever fails to match and falls back to `defaultResult`.
 */
const CONDITION_PATTERN = /^(output|trigger)((?:\.[a-zA-Z0-9_]+)*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/;

export interface ConditionEvaluationContext {
  output: unknown;
  trigger: unknown;
}

export function evaluateCondition(
  expression: string | null | undefined,
  context: ConditionEvaluationContext,
  defaultResult = true
): { matched: boolean; parsed: boolean } {
  if (!expression || !expression.trim()) return { matched: true, parsed: true };
  const match = CONDITION_PATTERN.exec(expression.trim());
  if (!match) return { matched: defaultResult, parsed: false };

  const [, root, pathRaw, operator, literalRaw] = match;
  const path = pathRaw ? pathRaw.slice(1).split(".") : [];
  const rootValue = root === "output" ? context.output : context.trigger;
  const actual = resolvePath(rootValue, path);
  const expected = parseLiteral((literalRaw ?? "").trim());

  return { matched: compare(actual, expected, operator ?? ""), parsed: true };
}

function resolvePath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    if (key === "length" && Array.isArray(current)) {
      current = current.length;
      continue;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function parseLiteral(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
    return raw.slice(1, -1);
  return raw;
}

function compare(actual: unknown, expected: unknown, operator: string): boolean {
  switch (operator) {
    case "==":
      return actual === expected;
    case "!=":
      return actual !== expected;
    case ">":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case ">=":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "<":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "<=":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    default:
      return false;
  }
}

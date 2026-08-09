import { describe, expect, it } from "vitest";
import { evaluateCondition } from "./skill-pipeline-condition";

describe("evaluateCondition", () => {
  it("matches when no expression is given", () => {
    expect(evaluateCondition(undefined, { output: {}, trigger: {} }).matched).toBe(true);
    expect(evaluateCondition("  ", { output: {}, trigger: {} }).matched).toBe(true);
  });

  it("evaluates a numeric comparison against the previous node's output", () => {
    const result = evaluateCondition("output.score > 5", { output: { score: 10 }, trigger: {} });
    expect(result).toEqual({ matched: true, parsed: true });
  });

  it("evaluates a false numeric comparison", () => {
    const result = evaluateCondition("output.score > 50", { output: { score: 10 }, trigger: {} });
    expect(result).toEqual({ matched: false, parsed: true });
  });

  it("supports array length via the .length pseudo-property", () => {
    const matched = evaluateCondition("output.warnings.length == 0", { output: { warnings: [] }, trigger: {} });
    expect(matched.matched).toBe(true);
    const notMatched = evaluateCondition("output.warnings.length == 0", { output: { warnings: ["x"] }, trigger: {} });
    expect(notMatched.matched).toBe(false);
  });

  it("supports string equality with quoted literals", () => {
    const matched = evaluateCondition('output.status == "ok"', { output: { status: "ok" }, trigger: {} });
    expect(matched.matched).toBe(true);
  });

  it("supports reading from the pipeline's original trigger input", () => {
    const matched = evaluateCondition("trigger.locale == \"en\"", { output: {}, trigger: { locale: "en" } });
    expect(matched.matched).toBe(true);
  });

  it("supports nested dot paths", () => {
    const matched = evaluateCondition("output.metadata.confidence >= 0.8", {
      output: { metadata: { confidence: 0.9 } },
      trigger: {}
    });
    expect(matched.matched).toBe(true);
  });

  it("falls back to defaultResult=true for an unparsable expression, never executing it", () => {
    const result = evaluateCondition("require('fs').readFileSync('/etc/passwd')", { output: {}, trigger: {} });
    expect(result).toEqual({ matched: true, parsed: false });
  });

  it("respects an explicit defaultResult=false for unparsable expressions", () => {
    const result = evaluateCondition("garbage(((", { output: {}, trigger: {} }, false);
    expect(result).toEqual({ matched: false, parsed: false });
  });

  it("treats a missing path as undefined, never throwing", () => {
    const result = evaluateCondition("output.nested.deep.missing == 1", { output: { nested: {} }, trigger: {} });
    expect(result.matched).toBe(false);
  });

  it("resolves a __proto__ path lookup as a harmless property read, never as prototype pollution", () => {
    const result = evaluateCondition("output.__proto__.polluted == true", { output: {}, trigger: {} });
    expect(result.matched).toBe(false);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});

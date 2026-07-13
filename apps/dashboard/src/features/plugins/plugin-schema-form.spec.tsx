import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SchemaFields } from "./plugin-schema-form";
import type { PluginConfigurationSchema } from "./plugin-api";
const schema: PluginConfigurationSchema = {
  type: "object",
  required: ["prefix"],
  properties: {
    prefix: { type: "string", title: "Prefix", description: "Text prefix", default: "Hello" },
    active: { type: "boolean" },
    mode: { type: "string", enum: ["safe", "fast"] },
    count: { type: "integer" },
    token: { type: "string", format: "password", writeOnly: true }
  }
};
describe("plugin schema form", () => {
  it("renders typed public configuration fields without raw JSON or secrets", () => {
    const markup = renderToStaticMarkup(<SchemaFields schema={schema} />);
    expect(markup).toContain("Prefix");
    expect(markup).toContain('value="Hello"');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain("<select");
    expect(markup).toContain('type="number"');
    expect(markup).not.toContain("token");
    expect(markup).not.toContain("JSON");
  });
  it("renders secret metadata only as blank password controls", () => {
    const markup = renderToStaticMarkup(
      <SchemaFields schema={schema} values={{ token: true }} secretMode />
    );
    expect(markup).toContain('type="password"');
    expect(markup).toContain("Leave blank to keep existing value");
    expect(markup).not.toContain('value="true"');
  });
});

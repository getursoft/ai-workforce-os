import { describe, expect, it } from "vitest";
import {
  ConnectorManifestValidator,
  ConnectorRegistry,
  ConnectorSchemaValidator,
  ConnectorValidationError,
  bounded
} from "./connector.runtime";
import { dummyCrmManifest } from "./reference-connectors";

describe("connector runtime", () => {
  it("validates the reference manifest and rejects duplicates and undeclared capabilities", () => {
    const validator = new ConnectorManifestValidator();
    expect(validator.validate(dummyCrmManifest).id).toBe("dummy-crm");
    expect(() =>
      validator.validate({
        ...dummyCrmManifest,
        version: "invalid",
        tools: [
          dummyCrmManifest.tools[0],
          { ...dummyCrmManifest.tools[0], requiredCapability: "UNDECLARED" }
        ]
      })
    ).toThrow(ConnectorValidationError);
  });
  it("prevents duplicate connector registration", () => {
    const registry = new ConnectorRegistry();
    const connector = {
      manifest: dummyCrmManifest,
      testConnection: async () => ({ status: "READY" as const, checkedAt: "" }),
      healthCheck: async () => ({ status: "READY" as const, checkedAt: "" }),
      executeTool: async () => ({})
    };
    registry.register(connector);
    expect(registry.resolve("dummy-crm")).toBe(connector);
    expect(() => registry.register(connector)).toThrow("CONNECTOR_ALREADY_REGISTERED");
  });
  it("bounds connector operations", async () => {
    await expect(bounded(new Promise(() => undefined), 5)).rejects.toThrow(
      "CONNECTOR_TOOL_TIMEOUT"
    );
  });
  it("rejects unsafe or malformed configured base URLs", () => {
    const schemas = new ConnectorSchemaValidator();
    expect(() =>
      schemas.validate(
        "url",
        { type: "object", properties: { baseUrl: { type: "string", format: "uri" } } },
        { baseUrl: "file:///etc/passwd" }
      )
    ).toThrow(ConnectorValidationError);
  });
});

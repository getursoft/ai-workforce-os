import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { AiConfigurationController } from "./ai-configuration/ai-configuration.controller";
import { BillingController } from "./billing/billing.controller";
import { CustomerSupportEmployeeController } from "./customer-support/customer-support-employee.controller";
import { FinanceEmployeeController } from "./finance/finance-employee.controller";
import { HrEmployeeController } from "./hr/hr-employee.controller";
import { ItSupportEmployeeController } from "./it-support/it-support-employee.controller";
import { KnowledgeController } from "./knowledge/knowledge.controller";
import { LegalDocumentController } from "./legal/legal-document.controller";
import { LegalEmployeeController } from "./legal/legal-employee.controller";
import { MarketingEmployeeController } from "./marketing/marketing-employee.controller";
import { SalesEmployeeController } from "./sales/sales-employee.controller";
import { SkillPlatformController } from "./skills-platform/skill-platform.controller";
import { TravelEmployeeController } from "./travel/travel.controller";
import { WorkforceController } from "./workforce/workforce.controller";

/**
 * Agent terminology migration (docs/AGENT_TERMINOLOGY_STANDARD.md): every public route that used the
 * legacy "employee" wording must ALSO be served under the canonical "agent" wording, and the legacy
 * path must keep working for existing API consumers (service accounts, API keys, the shipped iOS app).
 */
const PATH = "path";
const paths = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : [value as string]);

function controllerPaths(controller: object): string[] {
  return paths(Reflect.getMetadata(PATH, controller));
}

function routePaths(controller: { prototype: object }): string[] {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== "constructor" && typeof proto[name] === "function")
    .flatMap((name) => paths(Reflect.getMetadata(PATH, proto[name] as object)))
    .filter((p) => typeof p === "string");
}

describe("Agent terminology — controller prefix aliases", () => {
  const prefixed: Array<[string, object, string]> = [
    ["travel", TravelEmployeeController, "travel"],
    ["hr", HrEmployeeController, "hr"],
    ["finance", FinanceEmployeeController, "finance"],
    ["it-support", ItSupportEmployeeController, "it-support"],
    ["sales", SalesEmployeeController, "sales"],
    ["marketing", MarketingEmployeeController, "marketing"],
    ["legal", LegalEmployeeController, "legal"],
    ["customer-support", CustomerSupportEmployeeController, "customer-support"]
  ];
  for (const [label, controller, base] of prefixed) {
    it(`${label}: serves both /${base}-agent and the legacy /${base}-employee`, () => {
      expect(controllerPaths(controller)).toEqual([`${base}-agent`, `${base}-employee`]);
    });
  }

  it("legal documents: serves both legal-agent/documents and legacy legal-employee/documents", () => {
    expect(controllerPaths(LegalDocumentController)).toEqual(["legal-agent/documents", "legal-employee/documents"]);
  });
});

describe("Agent terminology — route aliases", () => {
  const cases: Array<[string, { prototype: object }, string, string]> = [
    ["workforce", WorkforceController, "agents", "employees"],
    ["billing", BillingController, "usage/by-agent", "usage/by-employee"],
    ["billing", BillingController, "usage/trend-by-agent", "usage/trend-by-employee"],
    ["billing", BillingController, "usage/agents", "usage/employees"],
    ["billing", BillingController, "usage/agents/:id", "usage/employees/:id"],
    ["knowledge", KnowledgeController, "agents/:employeeId/collections", "employees/:employeeId/collections"],
    ["knowledge", KnowledgeController, "agents/:employeeId/documents", "employees/:employeeId/documents"],
    ["knowledge", KnowledgeController, "agents/:employeeId/search", "employees/:employeeId/search"],
    ["ai-configuration", AiConfigurationController, "agents/:pluginId/assignments", "employees/:pluginId/assignments"],
    ["skills", SkillPlatformController, "agents/:employeeId/skills", "employees/:employeeId/skills"]
  ];
  for (const [label, controller, agentPath, legacyPath] of cases) {
    it(`${label}: ${agentPath} is an alias of the legacy ${legacyPath}`, () => {
      const all = routePaths(controller);
      expect(all).toContain(agentPath);
      expect(all).toContain(legacyPath);
    });
  }
});

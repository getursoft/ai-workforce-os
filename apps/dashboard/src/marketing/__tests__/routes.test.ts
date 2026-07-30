import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const marketingRoot = path.resolve(__dirname, "../../app/(marketing)");
const appRoot = path.resolve(__dirname, "../../app");

const expectedMarketingRoutes = [
  "page.tsx",
  "platform/page.tsx",
  "platform/capabilities/page.tsx",
  "platform/knowledge/page.tsx",
  "platform/integrations/page.tsx",
  "platform/security/page.tsx",
  "platform/analytics/page.tsx",
  "meet-ai-employees/page.tsx",
  "meet-ai-employees/travel/page.tsx",
  "meet-ai-employees/hr/page.tsx",
  "meet-ai-employees/finance/page.tsx",
  "meet-ai-employees/it-support/page.tsx",
  "meet-ai-employees/sales/page.tsx",
  "meet-ai-employees/marketing/page.tsx",
  "meet-ai-employees/legal/page.tsx",
  "meet-ai-employees/customer-support/page.tsx",
  "meet-ai-employees/custom/page.tsx",
  "solutions/page.tsx",
  "solutions/customer-service/page.tsx",
  "solutions/operations/page.tsx",
  "solutions/sales/page.tsx",
  "solutions/marketing/page.tsx",
  "solutions/hr/page.tsx",
  "solutions/finance/page.tsx",
  "solutions/it/page.tsx",
  "solutions/travel/page.tsx",
  "solutions/enterprise/page.tsx",
  "solutions/startups/page.tsx",
  "connect/page.tsx",
  "customers/page.tsx",
  "pricing/page.tsx",
  "about/page.tsx",
  "contact/page.tsx",
  "book-demo/page.tsx",
  "resources/page.tsx",
  "resources/blog/page.tsx",
  "resources/blog/[slug]/page.tsx",
  "resources/case-studies/page.tsx",
  "resources/documentation/page.tsx",
  "resources/help-centre/page.tsx",
  "resources/faq/page.tsx",
  "security/page.tsx",
  "privacy/page.tsx",
  "terms/page.tsx",
  "cookies/page.tsx",
];

describe("Route file availability", () => {
  it("has a page.tsx for every required marketing route", () => {
    for (const route of expectedMarketingRoutes) {
      const filePath = path.join(marketingRoot, route);
      expect(fs.existsSync(filePath), `Missing route file: (marketing)/${route}`).toBe(true);
    }
  });

  it("has a real login page outside the marketing group (the merged app's actual auth route)", () => {
    expect(fs.existsSync(path.join(appRoot, "(auth)/login/page.tsx"))).toBe(true);
  });

  it("has no page.tsx file with empty or near-empty content", () => {
    for (const route of expectedMarketingRoutes) {
      const filePath = path.join(marketingRoot, route);
      const contents = fs.readFileSync(filePath, "utf-8");
      expect(contents.trim().length, `${route} looks empty`).toBeGreaterThan(200);
    }
  });
});

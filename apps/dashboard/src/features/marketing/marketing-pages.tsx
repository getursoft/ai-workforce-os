import { EmployeePage, type EmployeePageSpec } from "../employees/employee-pages";

const MARKETING_SPEC: EmployeePageSpec = {
  pluginId: "marketing-employee",
  permissionPrefix: "marketing",
  artifactNoun: "campaign brief",
  title: "Marketing Employee",
  description: "Configure the AI marketing employee shared by Dashboard chat and WhatsApp.",
  basePath: "/marketing-employee",
  artifactEndpoint: "campaigns",
  showApiToggle: true,
  fallbackDescription:
    "Supports campaign planning, drafts on-brand content and summarises performance so your marketing team can focus on strategy."
};

export function MarketingEmployeePage() {
  return <EmployeePage spec={MARKETING_SPEC} />;
}

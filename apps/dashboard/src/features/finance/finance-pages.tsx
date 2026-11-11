import { EmployeePage, type EmployeePageSpec } from "../employees/employee-pages";

const FINANCE_SPEC: EmployeePageSpec = {
  pluginId: "finance-employee",
  permissionPrefix: "finance",
  artifactNoun: "finance request",
  title: "Finance Agent",
  description: "Configure the AI finance agent shared by Dashboard chat and WhatsApp.",
  basePath: "/finance-agent",
  artifactEndpoint: "records",
  showApiToggle: true,
  fallbackDescription:
    "Helps with reports, invoices, expense classification and budget questions, with approvals kept in human hands."
};

export function FinanceEmployeePage() {
  return <EmployeePage spec={FINANCE_SPEC} />;
}

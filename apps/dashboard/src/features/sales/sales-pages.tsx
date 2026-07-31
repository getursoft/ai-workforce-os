import { EmployeePage, type EmployeePageSpec } from "../employees/employee-pages";

const SALES_SPEC: EmployeePageSpec = {
  pluginId: "sales-employee",
  permissionPrefix: "sales",
  artifactNoun: "sales lead",
  title: "Sales Employee",
  description: "Configure the AI sales employee shared by Dashboard chat and WhatsApp.",
  basePath: "/sales-employee",
  artifactEndpoint: "leads",
  showApiToggle: true,
  fallbackDescription:
    "Qualifies leads, answers product questions, prepares reps for meetings and keeps CRM data current."
};

export function SalesEmployeePage() {
  return <EmployeePage spec={SALES_SPEC} />;
}

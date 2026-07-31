import { EmployeePage, type EmployeePageSpec } from "../employees/employee-pages";

const SUPPORT_SPEC: EmployeePageSpec = {
  pluginId: "customer-support-employee",
  permissionPrefix: "support",
  artifactNoun: "support ticket",
  title: "Customer Support Employee",
  description: "Configure the AI customer support employee shared by Dashboard chat and WhatsApp.",
  basePath: "/customer-support-employee",
  artifactEndpoint: "tickets",
  showApiToggle: true,
  fallbackDescription:
    "Answers customer questions, troubleshoots common issues and keeps support tickets moving around the clock."
};

export function CustomerSupportEmployeePage() {
  return <EmployeePage spec={SUPPORT_SPEC} />;
}

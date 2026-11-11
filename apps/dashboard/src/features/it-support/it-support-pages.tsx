import { EmployeePage, type EmployeePageSpec } from "../employees/employee-pages";

const IT_SPEC: EmployeePageSpec = {
  pluginId: "it-support-employee",
  permissionPrefix: "it",
  artifactNoun: "IT support ticket",
  title: "IT Support Agent",
  description: "Configure the AI IT support agent shared by Dashboard chat and WhatsApp.",
  basePath: "/it-support-agent",
  artifactEndpoint: "tickets",
  showApiToggle: true,
  fallbackDescription:
    "Handles first-line technical support, searches your knowledge base and triages incidents before escalating to your IT team."
};

export function ItSupportEmployeePage() {
  return <EmployeePage spec={IT_SPEC} />;
}

import { EmployeePage, type EmployeePageSpec } from "../employees/employee-pages";

const HR_SPEC: EmployeePageSpec = {
  pluginId: "hr-employee",
  permissionPrefix: "hr",
  artifactNoun: "HR request",
  title: "HR Employee",
  description: "Configure the AI HR employee shared by Dashboard chat and WhatsApp.",
  basePath: "/hr-employee",
  artifactEndpoint: "tickets",
  showApiToggle: true,
  fallbackDescription:
    "Answers employee questions, guides onboarding and leave processes, and routes sensitive matters to your human HR team."
};

export function HrEmployeePage() {
  return <EmployeePage spec={HR_SPEC} />;
}

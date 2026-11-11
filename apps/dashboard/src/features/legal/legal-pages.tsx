import { EmployeePage, type EmployeePageSpec } from "../employees/employee-pages";

const LEGAL_SPEC: EmployeePageSpec = {
  pluginId: "legal-employee",
  permissionPrefix: "legal",
  artifactNoun: "legal notice record",
  title: "Legal Agent",
  description: "Configure the AI legal document agent shared by Dashboard chat and WhatsApp.",
  basePath: "/legal-agent",
  artifactEndpoint: "notices",
  showCountryField: true,
  fallbackDescription:
    "Reads incoming legal and regulatory notifications and drafts structured replies ready for professional review and filing."
};

export function LegalEmployeePage() {
  return <EmployeePage spec={LEGAL_SPEC} />;
}

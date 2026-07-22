import { loadSecurityConfig } from "../identity/infrastructure/security/security-config";

const config = loadSecurityConfig(process.env);
if (config.nodeEnvironment !== "production" && config.nodeEnvironment !== "staging")
  throw new Error("PRODUCTION_CONFIGURATION_INVALID");
if (config.allowDevelopmentImplementations) throw new Error("PRODUCTION_CONFIGURATION_INVALID");
process.stdout.write(`Production configuration valid for ${config.nodeEnvironment}.\n`);

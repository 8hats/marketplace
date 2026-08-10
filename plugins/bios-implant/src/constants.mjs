import os from "node:os";
import path from "node:path";

export const PACKAGE_NAME = "@agentuniversity/bios-implant";
export const PACKAGE_VERSION = "1.0.18";

export const CATALOG_NAME = "agent-university";
export const PLUGIN_NAME = "bios-implant";
export const PLUGIN_ID = "bios-implant@agent-university";

export const REMOTE_MCP = Object.freeze({
  name: "implant",
  url: "https://implant.agents.university/mcp",
  oauth: Object.freeze({
    callbackPort: 8484,
    clientId: "bios-implant",
    codex: Object.freeze({
      callbackPort: 8486,
      callbackUrl: "http://127.0.0.1:8486/callback",
      callbackId: "dXk1HafgCxhy",
      redirectUri: "http://127.0.0.1:8486/callback/dXk1HafgCxhy"
    }),
    scopes: Object.freeze([
      "openid",
      "offline_access",
      "bios:read",
      "worldmodel:read",
      "worldmodel:write"
    ])
  })
});

export const LOCAL_MCP_NAME = "implant-local";
export const LOCAL_MCP_PROTOCOL_VERSION = "2024-11-05";
export const LOCAL_MCP_SERVER_NAME = LOCAL_MCP_NAME;
export const LOCAL_MCP_SERVER_VERSION = PACKAGE_VERSION;

export const EXIT_CODE_SUCCESS = 0;
export const EXIT_CODE_FAILURE = 1;
export const EXIT_CODE_USAGE = 2;
export const EXIT_CODE_WARNING = 10;
export const EXIT_CODE_PARTIAL = 11;
export const EXIT_DOCTOR_HEALTHY = 0;
export const EXIT_DOCTOR_BROKEN = 1;
export const EXIT_DOCTOR_PARTIAL = 2;

export const STATUS_OK = "ok";
export const STATUS_WARNING = "warning";
export const STATUS_ERROR = "error";

export const WARNING_STALE_SCOPE_DUPLICATE = "stale-scope-duplicate";
export const WARNING_DEGRADED_ENVIRONMENT = "degraded-environment";
export const BINDING_REQUIRED_WARNING = "BINDING_REQUIRED";

export const AGENT_UNIVERSITY_DIRNAME = ".agent-university";
export const BIOS_IMPLANT_DIRNAME = "bios-implant";
export const CATALOG_DIRNAME = "catalog";
export const BIOS_DIRNAME = "bios";
export const AGENTS_DIRNAME = "agents";
export const PROJECTS_DIRNAME = "projects";
export const LABELS_DIRNAME = "labels";
export const GENERATIONS_DIRNAME = "generations";

export const ACTIVE_BIOS_FILENAME = "active-bios.md";
export const BINDING_FILENAME = "binding.json";
export const IDENTITY_FILENAME = "identity.json";
export const IDENTITY_FILE = IDENTITY_FILENAME;
export const STATUS_FILENAME = "status.json";

export const DEFAULT_LABEL = "default";
export const MAX_STAGE_BODY_BYTES = 10 * 1024 * 1024;
export const SCHEMA_VERSION = 1;

export function agentUniversityHome(homeDirectory = os.homedir()) {
  return path.join(homeDirectory, AGENT_UNIVERSITY_DIRNAME);
}

export function biosImplantHome(homeDirectory = os.homedir()) {
  return path.join(agentUniversityHome(homeDirectory), BIOS_IMPLANT_DIRNAME);
}

export function biosImplantCatalogHome(homeDirectory = os.homedir()) {
  return path.join(biosImplantHome(homeDirectory), CATALOG_DIRNAME);
}

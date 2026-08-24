import { ApiIncidentCommanderDriver } from "./api-incident-commander-driver.ts";
import { BrowserIncidentCommanderDriver } from "./browser-incident-commander-driver.ts";
import type { IncidentCommanderDriver } from "./incident-commander-driver.ts";

export function createIncidentCommanderDriver(): IncidentCommanderDriver {
  const selection = process.env.INCIDENT_COMMANDER_TEST_DRIVER ?? "api";
  if (selection === "api") return new ApiIncidentCommanderDriver();
  if (selection === "browser") return new BrowserIncidentCommanderDriver();
  throw new Error(`Unknown incident commander test driver: ${selection}`);
}

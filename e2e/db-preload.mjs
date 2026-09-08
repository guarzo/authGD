// E2E launcher only. No app import, route or production instrumentation hook.
import process from "node:process";
import {
  assertDatabaseIsolationEnvironment,
  installDatabaseIsolation,
} from "./db-isolation.ts";
installDatabaseIsolation(assertDatabaseIsolationEnvironment(process.env));

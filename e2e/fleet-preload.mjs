// Bundled by the launcher BEFORE spawning Next. One awaited plain-JS --import
// survives Next's NODE_OPTIONS rewriting without recursive compiler workers.
import process from "node:process";
import { installFleetInterception } from "./fleet-server-preload.ts";
import { installDatabaseIsolation } from "./db-isolation.ts";
await installFleetInterception();
// Interception has verified the owned/synthetic environment, including the
// narrowly identified offline-font compiler child. Keep its DB leases gated too.
installDatabaseIsolation(process.env.DATABASE_URL);

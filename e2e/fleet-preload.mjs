// Bundled by the launcher BEFORE spawning Next. One awaited plain-JS --import
// survives Next's NODE_OPTIONS rewriting without recursive compiler workers.
import { installFleetInterception } from "./fleet-server-preload.ts";
await installFleetInterception();

import process from "node:process";
import { assertFleetEnvironment } from "../../e2e/fleet-server.ts";
assertFleetEnvironment(process.env);
// Bundled by the harness test before spawning; no runtime compiler workers.
await import("./fleet-harness-child.ts");

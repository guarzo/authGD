import { BASE_ENV } from "./env";

// `??=`, not assignment: a test that sets a var itself — or a CI runner that
// exports one — keeps its value. This only fills what nothing else provided.
// getConfig() caches on first call, so this has to land before any test module
// imports it, which is exactly what setupFiles guarantees.
for (const [key, value] of Object.entries(BASE_ENV)) {
  process.env[key] ??= value;
}

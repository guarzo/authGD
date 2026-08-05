import { loadConfig, type Config } from "@/config";
import { BASE_ENV } from "./env";

export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({ ...BASE_ENV, ...overrides } as NodeJS.ProcessEnv);
}

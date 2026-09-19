import { afterEach, expect, it, vi } from "vitest";
import type { FleetSourceDeps } from "@/jobs/fleet-source";

const phases = vi.hoisted(() => ({
  cleanup: vi.fn(),
  sources: vi.fn(),
  automatic: vi.fn(),
}));
vi.mock("@/services/fleet-source-maintenance", () => ({
  cleanupFleetSources: phases.cleanup,
  reserveDueFleetSources: phases.sources,
}));
vi.mock("@/services/fleet-automatic", () => ({
  reserveDueFleetAutomatic: phases.automatic,
}));
import { runFleetSourceTick } from "@/worker/fleet-source-scheduler";

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

it.each(["cleanup", "sources"] as const)(
  "a failed %s phase still admits the independent remaining work",
  async (failed) => {
    const order: string[] = [];
    for (const [name, operation] of Object.entries(phases))
      operation.mockImplementation(async () => {
        order.push(name);
        if (name === failed) throw new Error("private backend detail");
        return 0;
      });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await runFleetSourceTick({ db: {} } as FleetSourceDeps, () => true);
    expect(order).toEqual(["cleanup", "sources", "automatic"]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("private backend detail");
  },
);

it.each(["closed", "busy", "backoff"])(
  "phase isolation does not bypass the %s discovery gate",
  async (gate) => {
    phases.cleanup.mockRejectedValue(new Error("unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    if (gate === "closed") controller.abort();
    const deps = {
      db: {},
      signal: controller.signal,
      now: () => new Date(1000),
      esi: { getFleetRetryAt: () => (gate === "backoff" ? 2000 : 0) },
    } as FleetSourceDeps;
    await runFleetSourceTick(deps, () => gate !== "busy");
    expect(phases.sources).toHaveBeenCalledOnce();
    expect(phases.automatic).not.toHaveBeenCalled();
  },
);

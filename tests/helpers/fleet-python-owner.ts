import { vi, type TestContext } from "vitest";
import { createFleetTrust } from "../../e2e/fleet-tls";
import { withFleetResources } from "../../e2e/fleet-resources";

/** Per-test acquisition owner, including failure/timeout before Python is ready. */
export function createFleetPythonOwner(context: Pick<TestContext, "onTestFinished">) {
  const trust = createFleetTrust();
  let installations:
    | ReturnType<typeof import("../../e2e/fleet-installations").createInstallations>
    | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= withFleetResources(async (own) => {
      own(trust, (trust) => trust.close());
      if (installations) own(installations, (installations) => installations.close());
    }));
  // The same disposer is awaited inside the test's 5s lifecycle budget. This
  // independent registration still runs when Vitest abandons a timed-out body.
  context.onTestFinished(close);
  return {
    trustRoot: trust.root,
    get installationRoot() {
      return installations?.root;
    },
    async start() {
      if (closing) throw new Error("[fleet-e2e] Python test owner already closing");
      vi.stubEnv("E2E_FLEET_TLS_ROOT", trust.root);
      vi.stubEnv("E2E_FLEET_INTEGRATIONS", "1");
      vi.stubEnv("E2E_FLEET_PORT", "3988");
      vi.resetModules();
      const { createInstallations } = await import("../../e2e/fleet-installations");
      if (closing) throw new Error("[fleet-e2e] Python test setup cancelled");
      // createInstallations registers the child at spawn, before its readiness
      // await. A hook timeout can therefore close even a partially started peer.
      installations = createInstallations();
      return await installations.start("a");
    },
    close,
  };
}

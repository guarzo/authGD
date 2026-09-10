import { it, expect, vi } from "vitest";
import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import * as fixtures from "../e2e/fleet-fixtures";
import { withFleetCertificateContext } from "../e2e/fleet-certificate";
import { withFleetResources } from "../e2e/fleet-resources";

it("cleanup drains all resources and retains the primary failure first", async () => {
  const primary = new Error("primary");
  const cleanup = new Error("cleanup");
  const ended: number[] = [];
  await expect(
    withFleetResources(async (own) => {
      own(1, (value) => {
        ended.push(value);
      });
      own(2, (value) => {
        ended.push(value);
        throw cleanup;
      });
      own(3, (value) => {
        ended.push(value);
      });
      throw primary;
    }),
  ).rejects.toMatchObject({ errors: [primary, cleanup] });
  expect(ended).toEqual([3, 2, 1]);
});

it("a refused real Chromium launch removes its owned proxy and trust", async () => {
  let owned: Awaited<ReturnType<typeof fixtures.startFleetFixtures>> | undefined;
  let root: string | undefined;
  const create = fixtures.startFleetFixtures;
  const launch = chromium.launch.bind(chromium);
  vi.spyOn(fixtures, "startFleetFixtures").mockImplementation(async (options) => {
    owned = await create(options);
    return owned;
  });
  vi.spyOn(chromium, "launch").mockImplementation((options) => {
    root = dirname(options!.env!.HOME!);
    // Actual Playwright failed-start path, not a fabricated successful browser.
    return launch({ ...options, executablePath: "/no-owned-chromium-here" });
  });
  try {
    await expect(
      withFleetCertificateContext("untrusted", async () => {
        throw new Error("unreachable");
      }),
    ).rejects.toThrow(/executable doesn't exist/);
    expect(root).toBeTruthy();
    expect(existsSync(root!)).toBe(false);
    await expect(owned!.client.health()).rejects.toThrow();
  } finally {
    // Retain a test-owned backstop even when the deliberately RED helper leaks.
    await owned?.close();
    vi.restoreAllMocks();
  }
});

import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgressNotifier } from "@/lib/healthcheck-progress";

const url = "https://hc-ping.example/secret-check-id";
const live = { syncMode: "live" as const, healthcheckProgressUrl: url };
afterEach(() => vi.restoreAllMocks());

describe("sync progress notifier", () => {
  it.each([
    { syncMode: "live" as const, healthcheckProgressUrl: undefined },
    { syncMode: "live" as const, healthcheckProgressUrl: "" },
    { syncMode: "dry-run" as const, healthcheckProgressUrl: url },
  ])("does not contact monitoring when disabled: %j", async (cfg) => {
    const fetchImpl = vi.fn<typeof fetch>();
    createProgressNotifier(cfg, fetchImpl)();
    await setImmediate();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends a bounded bodyless GET, refuses redirects and releases the response", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const response = new Response("ok");
    const cancel = vi.spyOn(response.body!, "cancel");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const notify = createProgressNotifier(live, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(notify()).toBeUndefined();
    await setImmediate();
    expect(timeout).toHaveBeenCalledWith(5_000);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["non-2xx", "rejection", "synchronous throw", "redirect rejection"])(
    "contains %s without logging secrets or response text",
    async (failure) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const secretError = new Error(`sensitive transport error: ${url}`);
      const response = new Response(`sensitive response: ${url}`, { status: 503 });
      const cancel = vi.spyOn(response.body!, "cancel");
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
        if (failure === "synchronous throw") throw secretError;
        if (failure !== "non-2xx") return Promise.reject(secretError);
        return Promise.resolve(response);
      });
      expect(createProgressNotifier(live, fetchImpl)()).toBeUndefined();
      await setImmediate();
      expect(log.mock.calls).toEqual([["sync progress ping failed"]]);
      if (failure === "non-2xx") expect(cancel).toHaveBeenCalledOnce();
      if (failure === "redirect rejection") {
        expect(fetchImpl.mock.calls[0][1]?.redirect).toBe("error");
      }
    },
  );

  it("returns before a pending request, then contains its abort rejection", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new Error(url)), {
            once: true,
          });
        }),
    );
    expect(createProgressNotifier(live, fetchImpl)()).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    controller.abort();
    await setImmediate();
    expect(log.mock.calls).toEqual([["sync progress ping failed"]]);
  });
});

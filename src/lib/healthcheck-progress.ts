import type { Config } from "@/config";

/** Only the worker enables this; delivery must never delay or fail sync work. */
export function createProgressNotifier(
  cfg: Pick<Config, "syncMode" | "healthcheckProgressUrl">,
  fetchImpl: typeof fetch = fetch,
): () => void {
  const url = cfg.healthcheckProgressUrl;
  if (!url || cfg.syncMode === "dry-run") return () => {};

  return () => {
    void (async () => {
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        });
        await response.body?.cancel();
        if (!response.ok) console.error("sync progress ping failed");
      } catch {
        // Transport errors can contain the secret ping URL.
        console.error("sync progress ping failed");
      }
    })();
  };
}

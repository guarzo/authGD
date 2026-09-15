"use client";

import { useRef, useState } from "react";
import { Notice } from "@/app/_components/ui";

export function RecruitmentDownload({
  accountId,
  identity,
}: {
  accountId: string;
  identity: string;
}) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  async function collect() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setFailed(false);
    setMessage("Collecting all linked characters. This may take a few minutes.");
    try {
      const response = await fetch(`/admin/accounts/${accountId}/recruitment`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(150_000),
      });
      if (!response.ok) {
        setFailed(true);
        setMessage(
          response.status === 409
            ? "Character links or ownership changed. Reload the account before collecting again."
            : response.status === 403
              ? "Admin access or your session changed. Reload before collecting again."
              : response.status === 404
                ? "This account is no longer available. Reload the account list."
                : "Evidence could not be collected. Try again later.",
        );
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `recruitment-${accountId}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      // Let the browser take ownership of the download before releasing its URL.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(
        "Evidence download started. Check the snapshot for missing permissions and collection gaps before review.",
      );
    } catch {
      setFailed(true);
      setMessage(
        "Evidence could not be downloaded. Check your connection and try again.",
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <section className="drawer__group">
      <span className="drawer__label">Recruitment evidence</span>
      <p className="dim">
        One-time collection of all linked characters. Downloads private ESI data for
        review outside authGD.
      </p>
      <button
        type="button"
        className="btn"
        disabled={pending}
        aria-label={`Collect recruitment evidence for ${identity}`}
        onClick={() => {
          void collect();
        }}
      >
        {pending ? "Collecting…" : "Collect recruitment evidence"}
      </button>
      <Notice tone={failed ? "bad" : "info"}>{message}</Notice>
    </section>
  );
}

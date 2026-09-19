"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type {
  AutomaticOff,
  BrowserAutomaticView,
  BrowserOffReply,
} from "@/core/fleet-automatic";
import { Notice, RuleHead } from "@/app/_components/ui";

type OffAction = (command: AutomaticOff) => Promise<BrowserOffReply>;

export function AutomaticOffControl({
  initial,
  offAction,
}: {
  initial: BrowserAutomaticView | null;
  offAction: OffAction;
}) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [pending, startTransition] = useTransition();
  const [retry, setRetry] = useState(false);
  const [message, setMessage] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [observed, setObserved] = useState<BrowserAutomaticView | null>(null);
  const admitted = useRef<{ command: AutomaticOff; action: OffAction } | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    setReady(true);
    return () => {
      mounted.current = false;
    };
  }, []);
  // A response can describe an earlier consent than a concurrent route refresh.
  // Neither may replace the original command retained for a response-loss retry.
  const view =
    observed &&
    initial &&
    (observed.consent.generation > initial.consent.generation ||
      (observed.consent.generation === initial.consent.generation &&
        observed.consent.revision > initial.consent.revision))
      ? observed
      : initial;

  function turnOff() {
    if (!ready || busy.current || (!admitted.current && !view?.consent.enabled)) return;
    if (!admitted.current) {
      admitted.current = {
        action: offAction,
        command: {
          protocol: 2,
          enabled: false,
          request_id: crypto.randomUUID(),
          intent_created_at: new Date().toISOString(),
          expected_generation: view!.consent.generation,
          expected_revision: view!.consent.revision,
        },
      };
    }
    const original = admitted.current;
    busy.current = true;
    setRetry(true);
    setMessage("");
    setAcknowledged(false);
    startTransition(async () => {
      try {
        const reply = await original.action(original.command);
        if (!mounted.current) return;
        if (!reply || reply.request_id !== original.command.request_id) {
          setMessage("The Off outcome is unconfirmed. Retry sends the same request.");
          return;
        }
        if (reply.status) setObserved(reply.status);
        if (reply.ok) {
          admitted.current = null;
          setRetry(false);
          setAcknowledged(true);
        } else if (
          reply.error === "conflict" ||
          reply.error === "invalid_intent" ||
          reply.error === "request_id_conflict" ||
          reply.error === "bad_request"
        ) {
          admitted.current = null;
          setRetry(false);
          setMessage(
            "The account choice changed or the request was refused. Review the current state before submitting another Off request.",
          );
        } else {
          setMessage(
            reply.error === "unauthorized"
              ? "Authentication changed. Sign in to the original account before retrying this Off request."
              : "The Off outcome is unconfirmed. Retry sends the same request.",
          );
        }
      } catch {
        if (mounted.current)
          setMessage("The Off outcome is unconfirmed. Retry sends the same request.");
      } finally {
        busy.current = false;
      }
    });
  }
  return (
    <section aria-label="Automatic boss verification">
      <RuleHead as="h2">Automatic boss verification</RuleHead>
      <p>
        Automatic boss verification:{" "}
        {view ? (view.consent.enabled ? "On" : "Off") : "Unknown"}
      </p>
      <p className="table-note">
        This is an account choice. Turning it Off stops automatic roster verification
        without unpairing devices or changing this PC’s telemetry participation. Turn it
        On only through Wingman’s explicit consent flow.
      </p>
      <div className="btn-row">
        {(retry || view?.consent.enabled) && (
          <button
            type="button"
            className="btn"
            disabled={!ready || pending}
            onClick={turnOff}
          >
            {pending
              ? "Requesting Off…"
              : retry
                ? "Retry the same Off request"
                : "Turn off automatic verification"}
          </button>
        )}
        <button
          type="button"
          className="btn btn--quiet"
          disabled={!ready || pending}
          onClick={() => router.refresh()}
        >
          Refresh verification state
        </button>
      </div>
      <Notice>
        {pending
          ? "Off requested; awaiting acknowledgement."
          : message ||
            (acknowledged
              ? view?.consent.enabled
                ? "Your earlier Off was acknowledged. Automatic verification is currently On; review the new choice before turning it Off."
                : "Off request acknowledged. Devices remain paired."
              : !view
                ? "Could not read automatic verification. Refresh to try again."
                : "")}
      </Notice>
    </section>
  );
}

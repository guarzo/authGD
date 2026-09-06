"use client";

import { useActionState, useEffect, useState } from "react";
import type { FleetAccessCode } from "@/core/fleet-access";
import type { FleetSharingCharacter } from "@/services/fleet-sharing-view";
import { Notice, RuleHead, Status } from "@/app/_components/ui";
import { Submit } from "@/app/_components/submit";
import { checkFleetAccessAction } from "./actions";

const messages: Record<Exclude<FleetAccessCode, "checked">, string> = {
  not_authorized:
    "Not authorized. Authorize Fleet Read for this character before checking.",
  not_in_fleet: "Not in a fleet. Join a fleet with this character, then check again.",
  authorization_rejected:
    "EVE rejected the authorization. Authorize Fleet Read again, then retry. The response does not establish the cause.",
  roster_unavailable:
    "Fleet roster unavailable. EVE did not provide a usable roster; no linked characters were verified.",
  identity_changed:
    "Account or authorization changed during the check. Reload this page before trying again.",
  timed_out:
    "Fleet check timed out. No linked characters were verified. Try again after the cooldown.",
  service_unavailable:
    "Fleet service unavailable. No linked characters were verified. Try again later.",
  cooldown:
    "Check cooldown. Checks are limited across your account, including other characters and tabs.",
  not_eligible: "Fleet sharing requires a current Member-tier account.",
};
function timestamp(iso: string) {
  return new Date(iso)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

function AnchorCheck({ anchor }: { anchor: FleetSharingCharacter }) {
  const [state, action, pending] = useActionState(checkFleetAccessAction, null);
  const authorized = anchor.hasFleetRead && anchor.tokenUsable;
  // React retains the previous action result while a new one runs. Never show
  // that old observation as if it were evidence for the pending check.
  const result = pending ? null : state;
  return (
    <>
      <p className="table-note">
        <Status tone={authorized ? "ok" : "warn"}>
          {authorized ? "Fleet Read authorized" : "Not authorized"}
        </Status>
      </p>
      <p className="btn-row">
        <a
          className={authorized ? "btn" : "btn btn--primary"}
          href={`/auth/eve/fleet-read?character=${anchor.characterId}`}
        >
          Authorize Fleet Read
        </a>
      </p>
      <RuleHead as="h2">Check linked characters</RuleHead>
      <p className="table-note">
        This is a point-in-time fleet-access check, not running Wingman sharing.
      </p>
      <form
        action={action}
        onSubmit={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <input type="hidden" name="anchorCharacterId" value={anchor.characterId} />
        <Submit
          className="btn btn--primary"
          disabled={!authorized}
          pendingLabel="Checking fleet…"
        >
          Check fleet
        </Submit>
      </form>
      <section aria-label="Fleet check result" className="pager">
        <Notice>
          {pending ? (
            "Checking fleet. Saving authorization can take longer; wait for this check to finish."
          ) : result?.code === "checked" && result.checkedAt ? (
            <>
              Checked at{" "}
              <time dateTime={result.checkedAt}>{timestamp(result.checkedAt)}</time>.
            </>
          ) : result && result.code !== "checked" ? (
            messages[result.code]
          ) : authorized ? (
            "Not checked. Check fleet to verify your linked characters."
          ) : (
            messages.not_authorized
          )}
        </Notice>
        {result?.code === "checked" && (
          <ul className="mono">
            {result.characters.map((ch) => (
              <li key={ch.characterId}>{ch.characterName}</li>
            ))}
          </ul>
        )}
        {result?.retryAt && (
          <p className="table-note">
            {result.code === "checked" ? "Next check available at " : "Try again at "}
            <time dateTime={result.retryAt}>{timestamp(result.retryAt)}</time>.
          </p>
        )}
      </section>
    </>
  );
}

export function FleetCheckForm({ characters }: { characters: FleetSharingCharacter[] }) {
  const [selected, setSelected] = useState(characters[0].characterId);
  const [ready, setReady] = useState(false);
  // Native selects can change before hydration attaches onChange, leaving the
  // authorization link aimed at a different character than the visible choice.
  useEffect(() => {
    setReady(true);
  }, []);
  const anchor = characters.find((ch) => ch.characterId === selected)!;
  return (
    <>
      <RuleHead as="h2">Fleet Read authorization</RuleHead>
      <div className="form-stack__field">
        <label htmlFor="fleet-anchor">Authorization character</label>
        <select
          className="field"
          id="fleet-anchor"
          disabled={!ready}
          value={selected}
          onChange={(event) => setSelected(Number(event.target.value))}
        >
          {characters.map((ch) => (
            <option key={ch.characterId} value={ch.characterId}>
              {ch.characterName}
            </option>
          ))}
        </select>
        {!ready && <p className="table-note">Loading character controls…</p>}
      </div>
      {/* A selection owns its action state. Unmounting discards late responses,
        even if the user switches back before the old action finishes. */}
      <AnchorCheck key={selected} anchor={anchor} />
    </>
  );
}

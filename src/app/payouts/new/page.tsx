import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Notice, SiteHeader } from "@/app/_components/ui";
import { Submit } from "@/app/_components/submit";
import { requirePayoutReader } from "../access";
import { createOperationAction } from "../actions";
import { NEW_OPERATION_ERRORS, lookupErrorMessage } from "../errors";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "New payout operation",
};

/** Every code `createOperationAction` can reject with, and the copy for each,
 *  lives in `../errors` — with the type that stops the action emitting one the
 *  map has no entry for. */

export default async function NewPayoutPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    name?: string;
    occurredAt?: string;
    battleReportUrl?: string;
    corpSharePct?: string;
    notes?: string;
  }>;
}) {
  const access = await requirePayoutReader();
  if (!access) redirect("/account");
  // A cryo flygd member (or any non-operator flygd reader) can reach this URL
  // directly; the list page hides the link, this page hides the form, and the
  // action rejects anyway. Reading a form that will only reject on submit is
  // worse than not being handed the form.
  if (!access.isOperator) redirect("/payouts");

  const submitted = await searchParams;
  const errorMessage = lookupErrorMessage(NEW_OPERATION_ERRORS, submitted.error);

  const nav = [
    { href: "/account", label: "Your account" },
    { href: "/payouts", label: "Payouts" },
    ...(access.isAdmin ? [{ href: "/admin/accounts", label: "Members" }] : []),
  ];

  return (
    <>
      <SiteHeader items={nav} current="/payouts" section />
      <main id="main" tabIndex={-1} className="page page--narrow">
        <div className="page__head">
          <h1>New operation</h1>
          <p className="page__lede">
            One row per fight. Loot, roster, and the split are added on the operation once
            it exists.
          </p>
        </div>

        {errorMessage && <Notice tone="bad">{errorMessage}</Notice>}

        <form action={createOperationAction} className="form-stack">
          <label className="form-stack__field">
            Name
            <input className="field" name="name" defaultValue={submitted.name} required />
          </label>
          <label className="form-stack__field">
            Date
            <input
              className="field"
              type="date"
              name="occurredAt"
              defaultValue={submitted.occurredAt}
              required
            />
          </label>
          <label className="form-stack__field">
            Battle report URL (optional)
            <input
              className="field"
              type="url"
              name="battleReportUrl"
              defaultValue={submitted.battleReportUrl}
            />
          </label>
          {/* No default. A pre-filled 0 is a number the operator never chose but
              the roster lives with, and until now it could not be changed after
              creation at all. Empty forces the decision; the action still
              accepts blank as 0 for anyone who means it. This cell is a div with
              an explicit label, unlike its siblings: the hint has to live outside
              the <label> or it gets concatenated into the input's accessible
              name — same arrangement /admin/audit uses for its filter hints. */}
          <div className="form-stack__field">
            <label htmlFor="corp-share-pct">Corp share %</label>
            <input
              id="corp-share-pct"
              className="field"
              type="number"
              name="corpSharePct"
              min="0"
              max="100"
              step="0.01"
              defaultValue={submitted.corpSharePct}
              required
              aria-describedby="corp-share-hint"
            />
            <span className="dim" id="corp-share-hint">
              Taken off the top before the roster splits the rest. Enter 0 if the corp
              takes nothing.
            </span>
          </div>
          <label className="form-stack__field">
            Notes (optional)
            <textarea
              className="field"
              name="notes"
              rows={3}
              defaultValue={submitted.notes}
            />
          </label>
          <Submit className="btn btn--primary">Create operation</Submit>
        </form>
      </main>
    </>
  );
}

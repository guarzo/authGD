import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Notice, SiteHeader } from "@/app/_components/ui";
import { brandProps } from "@/app/_components/brand-server";
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

/** Collapses a possibly-repeated query param to one value, last wins — the same
 *  helper `../page.tsx` and the audit page use, for the same reason: Next hands
 *  `string | string[]`, and a repeated param reaching code that declared only
 *  `string` took the audit page down with a 500. */
function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[v.length - 1] : v;
}

export default async function NewPayoutPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    name?: string | string[];
    occurredAt?: string | string[];
  }>;
}) {
  const access = await requirePayoutReader();
  if (!access) redirect("/account");
  // A cryo member (or any non-operator member reader) can reach this URL
  // directly; the list page hides the link, this page hides the form, and the
  // action rejects anyway. Reading a form that will only reject on submit is
  // worse than not being handed the form.
  if (!access.isOperator) redirect("/payouts");

  const raw = await searchParams;
  const submitted = {
    name: one(raw.name),
    occurredAt: one(raw.occurredAt),
  };
  const errorMessage = lookupErrorMessage(NEW_OPERATION_ERRORS, one(raw.error));

  // The field this form exists to stamp is almost always today's, and the
  // action parses `yyyy-mm-dd` as UTC midnight — which is EVE time — so the
  // same slice both pages already render is the right default rather than a
  // local-timezone guess. `??` keeps an echoed value winning over it, so a
  // rejected submit still comes back showing what the operator typed.
  const today = new Date().toISOString().slice(0, 10);

  const nav = [
    { href: "/account", label: "Your account" },
    { href: "/payouts", label: "Payouts" },
    ...(access.isAdmin ? [{ href: "/admin/accounts", label: "Members" }] : []),
  ];

  return (
    <>
      <SiteHeader items={nav} current="/payouts" section {...brandProps()} />
      <main id="main" tabIndex={-1} className="page page--narrow">
        <div className="page__head">
          <h1>New operation</h1>
          <p className="page__lede">
            One row per fight. Give it a name and a date; battle report, corp share, and
            notes can all be added on the operation once it exists. Creating one pays
            nobody: it opens a draft, and an admin can delete it later if it turns out to
            be a mistake.
          </p>
        </div>

        {/* Mounted unconditionally, not behind `&&`: the reserved slot registers
            the live region before the text arrives, so AT announces a change to
            it rather than a region born holding its own message. This is the one
            form in the app whose entire validation model is a server round trip,
            so it is the one that most needs the announcement to land. */}
        <Notice tone="bad">{errorMessage}</Notice>

        <form action={createOperationAction} className="form-stack">
          {/* Requiredness is spelled into the label rather than left to the
              `required` attribute alone. Both fields here are required, so
              there is no "optional" case left to distinguish them from. */}
          <label className="form-stack__field">
            Name (required)
            <input className="field" name="name" defaultValue={submitted.name} required />
          </label>
          <label className="form-stack__field">
            Date (required)
            <input
              className="field"
              type="date"
              name="occurredAt"
              defaultValue={submitted.occurredAt ?? today}
              max={today}
              required
            />
          </label>
          <Submit className="btn btn--primary" pendingLabel="Creating…">
            Create operation
          </Submit>
        </form>
      </main>
    </>
  );
}

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/app/_components/ui";
import { Submit } from "@/app/_components/submit";
import { requirePayoutReader } from "../access";
import { createOperationAction } from "../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "New payout operation",
};

export default async function NewPayoutPage() {
  const access = await requirePayoutReader();
  if (!access) redirect("/account");
  // A cryo flygd member (or any non-operator flygd reader) can reach this URL
  // directly; the list page hides the link, this page hides the form, and the
  // action rejects anyway. Reading a form that will only reject on submit is
  // worse than not being handed the form.
  if (!access.isOperator) redirect("/payouts");

  const nav = [
    { href: "/account", label: "Your account" },
    { href: "/payouts", label: "Payouts" },
    ...(access.isAdmin ? [{ href: "/admin/accounts", label: "Members" }] : []),
  ];

  return (
    <>
      <SiteHeader items={nav} current="/payouts" />
      <main id="main" tabIndex={-1} className="page page--narrow">
        <div className="page__head">
          <h1>New operation</h1>
          <p className="page__lede">
            One row per fight. Loot, roster, and the split are added on the operation once
            it exists.
          </p>
        </div>

        <form action={createOperationAction} className="stack">
          <label className="stack">
            Name
            <input className="field" name="name" required />
          </label>
          <label className="stack">
            Date
            <input className="field" type="date" name="occurredAt" required />
          </label>
          <label className="stack">
            Battle report URL (optional)
            <input className="field" type="url" name="battleReportUrl" />
          </label>
          <label className="stack">
            Corp share %
            <input
              className="field"
              type="number"
              name="corpSharePct"
              min="0"
              max="100"
              step="0.01"
              defaultValue="0"
              required
            />
          </label>
          <label className="stack">
            Notes (optional)
            <textarea className="field" name="notes" rows={3} />
          </label>
          <Submit className="btn btn--primary">Create operation</Submit>
        </form>
      </main>
    </>
  );
}

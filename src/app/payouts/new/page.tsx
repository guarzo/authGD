import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { navFor } from "@/app/_components/nav-items";
import { SiteHeader } from "@/app/_components/ui";
import { brandProps } from "@/app/_components/brand-server";
import { requirePayoutReader } from "../access";
import { NewOperationForm } from "./new-operation-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "New payout operation",
};

export default async function NewPayoutPage() {
  const access = await requirePayoutReader();
  if (!access) redirect("/account");
  // A cryo member (or any non-operator member reader) can reach this URL
  // directly; the list page hides the link, this page hides the form, and the
  // action rejects anyway. Reading a form that will only reject on submit is
  // worse than not being handed the form.
  if (!access.isOperator) redirect("/payouts");

  // The field this form exists to stamp is almost always today's, and the
  // action parses `yyyy-mm-dd` as UTC midnight — which is EVE time — so the
  // same slice both pages already render is the right default.
  const today = new Date().toISOString().slice(0, 10);

  // `canReadPayouts: true` is proven by `requirePayoutReader()` above having
  // returned non-null rather than redirecting — see payouts/page.tsx.
  const nav = navFor({ canReadPayouts: true, isAdmin: access.isAdmin });

  return (
    <>
      <SiteHeader items={nav} current="/payouts" section {...brandProps()} />
      <main id="main" tabIndex={-1} className="page page--narrow">
        <div className="page__head">
          <p className="page__stamp">Flight log</p>
          <h1>New operation</h1>
          <p className="page__lede">
            One row per fight. Creating an operation pays nobody: it opens a draft you can
            fill in now or later.
          </p>
        </div>

        {/* The form gets its own ground: a bare form on the page void read as a
            settings row rather than the start of a mission. `--hull` is what
            DESIGN.md names for an inset region, and a `--void` field inset into
            it is the contrast the field spec already assumes. The H1 and lede
            stay on the page ground; only the form itself is boxed, and it
            wears no registration ticks (those are the login panel's alone). */}
        <div className="form-panel">
          <NewOperationForm today={today} />
        </div>
      </main>
    </>
  );
}

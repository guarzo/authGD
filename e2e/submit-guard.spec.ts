import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";
import { payoutOperation } from "../src/db/schema";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

/**
 * The submit buttons stopped disabling themselves while their form is in
 * flight: disabling the element the member just pressed moves focus to
 * `<body>`, and every one of these actions ends in a server-action
 * `redirect()` — a client navigation, with no document load to put focus back.
 * `useSubmitGuard` is what replaced `disabled` as the re-entry stop, and this
 * is the case that made it non-negotiable rather than merely tidy: creating an
 * operation is not idempotent and nothing in the app can delete one, so a
 * double-click that got through would leave a permanent duplicate on the
 * payouts list and no way to clean it up.
 *
 * `dblclick` rather than two awaited `click`s. Two awaited clicks let React
 * commit the pending render in between, which is the state `useFormStatus`
 * would have caught on its own; the whole reason the guard holds a ref instead
 * is the pair of clicks that land inside one commit, and `dblclick` is how
 * Playwright dispatches that pair.
 */
test("double-clicking Create operation makes one operation, not two", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Doubletap",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Doubletap roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).dblclick();

  await expect(page).toHaveURL(/\/payouts\/[0-9a-f-]+$/);
  const rows = await db.select().from(payoutOperation);
  expect(rows.map((r) => r.name)).toEqual(["Doubletap roam"]);
});

/**
 * The other half of dropping `disabled`: the control the member pressed has to
 * still be there to hear the answer. A disabled button is not focusable, so the
 * browser moves focus to `<body>` the moment the pending render commits — and a
 * screen reader that was on the button is then somewhere with no name, on a
 * page that has not navigated yet.
 */
test("the pressed button keeps focus while its form is in flight", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Focus",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Focus roam");
  await page.getByLabel("Date").fill("2026-08-01");

  // Recorded rather than sampled. Reading `document.activeElement` once after
  // the press races the client navigation: land after it and focus is already
  // on the operation page's h1, which passes whether or not the button was
  // blurred on the way there. These two listeners are installed before the
  // press and survive it, because a server-action redirect is a client
  // navigation in the same document.
  await page.evaluate(() => {
    const w = window as unknown as { busy: boolean; lost: boolean };
    w.busy = false;
    w.lost = false;
    // Proves the form actually reached its pending state, so a submit that
    // never fired can't pass this test vacuously.
    new MutationObserver((records) => {
      for (const r of records) {
        if ((r.target as Element).getAttribute("aria-busy") === "true") w.busy = true;
      }
    }).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-busy"],
    });
    // The regression itself, and only it. Focus reaching `<body>` is not on its
    // own a defect: the navigation unmounts this whole form, and there is an
    // unavoidable moment between React removing the button and `FocusHeading`
    // taking the operation page's h1. What must never happen is focus leaving a
    // control that is *still there* — that is what `disabled` does, and it
    // strands the member on a nameless body for the whole round trip, on a page
    // that has not navigated yet. So the blurred element is checked for still
    // being in the document.
    document.addEventListener(
      "focusout",
      (e) => {
        const from = e.target as Element;
        queueMicrotask(() => {
          if (document.activeElement === document.body && from.isConnected) {
            w.lost = true;
          }
        });
      },
      true,
    );
  });

  const create = page.getByRole("button", { name: "Create operation" });
  await create.focus();
  await create.press("Enter");
  await expect(page).toHaveURL(/\/payouts\/[0-9a-f-]+$/);

  const { busy, lost } = await page.evaluate(() => {
    const w = window as unknown as { busy: boolean; lost: boolean };
    return { busy: w.busy, lost: w.lost };
  });
  expect(busy).toBe(true);
  expect(lost).toBe(false);
});

/**
 * The release half of the primitive, and the reason it is written down as a
 * test rather than a paragraph.
 *
 * The two tests above press once (or twice inside one commit) on a form that
 * navigates away, so they prove the guard *refuses* re-entry and prove nothing
 * about it letting go afterwards. That gap is not academic: `docs/e2e-flake-
 * triage.md` twice carried a confident and opposite claim about it — first that
 * the latch sticks permanently, then that it does not — and neither reading
 * could be rerun, because both rested on scratch probes that were deleted. This
 * is that probe, kept.
 *
 * The claim under test is falsifiable and narrow: **a press that follows a
 * dropped press always goes through.** A permanent latch predicts the opposite.
 *
 * Instrumentation is entirely page-level, and deliberately so. Adding per-
 * instance ids to `submit-guard.ts` crashed SSR (`window is not defined`), and
 * a single shared array in that module conflates every `Submit` on the page,
 * since they all share the one hook. Selecting on the button's own
 * `aria-label="save notes"` from outside separates this button from the dozen
 * other guarded ones on `/payouts/[id]` without the primitive knowing it is
 * being watched.
 *
 * Three things are recorded per press, none of them inferred:
 *
 *   - `busy` — `aria-busy` read synchronously in a capture-phase listener, so
 *     it is the value at dispatch, not a sample taken afterwards.
 *   - `prevented` — whether the guard refused this press. `preventDefault` is
 *     the drop itself, so this is a direct observation where a missing POST
 *     would only be evidence of one. It has to be read in a `setTimeout`, and
 *     that detail is load-bearing: this listener is installed by
 *     `addInitScript`, so it is registered *before* React's, and reading
 *     `defaultPrevented` inline would sample it before the guard has run. A
 *     `queueMicrotask` is not sufficient either, and the first version of this
 *     probe was wrong for exactly that reason — the HTML spec performs a
 *     microtask checkpoint between listener invocations, so the callback ran
 *     in the gap before React's handler rather than after dispatch. It
 *     recorded `prevented: false` for a press that provably emitted no POST,
 *     which silently turned the leak check below into a no-op. A task queued
 *     with `setTimeout` cannot run until dispatch has fully unwound.
 *   - whether a POST carrying that press's text was emitted at all.
 *
 * `notes-form.tsx` renders `· saved` only while the textarea still holds the
 * acknowledged text, so it is *not* usable as the barrier here: the dropped
 * press leaves different text on screen and the confirmation never appears.
 * The barrier is a balanced `aria-busy` ledger instead — equal true and false
 * transitions means the client has seen every action it started resolve, which
 * is the same thing `· saved` means in the simpler case.
 */
type SaveProbe = {
  clicks: { at: number; busy: string | null; prevented: boolean }[];
  busy: { at: number; busy: string | null }[];
};

test("a press refused mid-flight does not latch the guard: the next press saves", async ({
  page,
  context,
}, testInfo) => {
  const operator = await seedMember(db, {
    name: "FC Relatch",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.addInitScript(() => {
    const w = window as unknown as { __probe: SaveProbe };
    const t0 = performance.now();
    const at = () => Math.round(performance.now() - t0);
    w.__probe = { clicks: [], busy: [] };
    const isSave = (el: Element | null | undefined): el is Element =>
      !!el && el.getAttribute("aria-label") === "save notes";

    new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as Element;
        if (isSave(el))
          w.__probe.busy.push({ at: at(), busy: el.getAttribute("aria-busy") });
      }
    }).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-busy"],
    });

    document.addEventListener(
      "click",
      (e) => {
        const btn = (e.target as Element | null)?.closest?.("button");
        if (!isSave(btn)) return;
        const entry = {
          at: at(),
          busy: btn.getAttribute("aria-busy"),
          prevented: false,
        };
        w.__probe.clicks.push(entry);
        setTimeout(() => {
          entry.prevented = e.defaultPrevented;
        }, 0);
      },
      true,
    );
  });

  // Every server-action POST, with enough of its body to say which press it
  // belongs to. The three notes below share no substring, so matching is exact.
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST") posts.push(r.postData() ?? "");
  });
  const texts = ["alpha one", "bravo two", "charlie three"];
  const posted = (t: string) => posts.some((b) => b.includes(t));

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Relatch roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.getByRole("heading", { name: "Relatch roam" })).toBeVisible();

  const notes = page.getByRole("textbox", { name: "operation notes" });
  const save = page.getByRole("button", { name: "Save notes" });
  const probe = () =>
    page.evaluate(() => (window as unknown as { __probe: SaveProbe }).__probe);

  // "the client has seen every action it started resolve": one `false`
  // transition for every `true` one, and at least one of each. This is the
  // settle signal `· saved` cannot give us here.
  const idle = async () => {
    const p = await probe();
    const on = p.busy.filter((b) => b.busy === "true").length;
    const off = p.busy.filter((b) => b.busy === "false").length;
    return on > 0 && on === off;
  };

  // Press 1 — into an idle button. Must submit.
  await notes.fill("alpha one");
  await save.click();

  // Press 2 — immediately, with no wait of any kind, so it lands while press
  // 1's action is still in flight. This is the press the guard is expected to
  // refuse. It is deliberately NOT asserted as dropped: on a fast enough
  // machine press 1 could conceivably settle first, and a probe that fails
  // when the race it is probing does not occur would just be another flake.
  await notes.fill("bravo two");
  await save.click();

  // Now let everything the client started finish, so press 3 is unambiguous.
  await expect.poll(idle, { timeout: 15_000 }).toBe(true);

  // Press 3 — into a button the client has told us is idle. Whether or not
  // press 2 was dropped, this one must go through.
  await notes.fill("charlie three");
  await save.click();
  await expect.poll(idle, { timeout: 15_000 }).toBe(true);

  const p = await probe();
  const detail = JSON.stringify(p);

  // The per-press ledger, attached to the run rather than only quoted in an
  // assertion message. This test exists because two previous rounds of this
  // investigation could not be rerun; a green run that keeps no evidence would
  // repeat that. Retrieving it needs a reporter that keeps attachments —
  // `--reporter=html` then `npx playwright show-report`, or `--reporter=json`
  // — because this config sets none, and Playwright's default `list` reporter
  // discards an inline `body` attachment rather than writing it under
  // `test-results/`. With one, every iteration's drop record is there,
  // including the ones that passed.
  await testInfo.attach("press-ledger", {
    body: JSON.stringify(
      { clicks: p.clicks, busy: p.busy, postedTexts: texts.filter((t) => posted(t)) },
      null,
      2,
    ),
    contentType: "application/json",
  });

  // The release branch in the guard's effect can only run if a render with
  // `pending === true` committed. `aria-busy` mirrors that same `pending`, so
  // seeing it go true is direct evidence the branch is reachable — and its
  // absence was the whole basis of the retracted permanent-latch theory.
  expect(
    p.busy.some((b) => b.busy === "true"),
    `aria-busy never went true: ${detail}`,
  ).toBe(true);
  expect(p.clicks, `expected three recorded presses: ${detail}`).toHaveLength(3);

  // The falsifiable claim, asserted generally rather than only for press 3: if
  // a press was dropped, the next press made into an idle button must not be.
  for (let i = 1; i < p.clicks.length; i++) {
    if (!p.clicks[i - 1].prevented) continue;
    if (p.clicks[i].busy !== "false") continue;
    expect(
      p.clicks[i].prevented,
      `press ${i + 1} was refused with aria-busy=false at click time, after ` +
        `press ${i} was dropped. The guard leaked its latch: ${detail}`,
    ).toBe(false);
  }

  // Press 3 specifically: idle at click, so it must have submitted, and its
  // text must be what the server ended up holding.
  expect(p.clicks[2].busy, `press 3 was not idle at click: ${detail}`).toBe("false");
  expect(p.clicks[2].prevented, `press 3 was refused: ${detail}`).toBe(false);
  expect(posted("charlie three")).toBe(true);

  const stored = await db
    .select()
    .from(payoutOperation)
    .where(eq(payoutOperation.name, "Relatch roam"))
    .then(([row]) => row.notes);
  expect(stored).toBe("charlie three");

  // And the refusal itself is silent when it happens — no POST for a dropped
  // press. This is the product behaviour `docs/e2e-flake-triage.md` costs out;
  // asserting it here means a future change that adds feedback has to come
  // past this line rather than past a paragraph. Stated as an equivalence
  // rather than asserting the drop outright, because whether press 2 loses the
  // race is exactly the thing being sampled: on a fast enough machine it may
  // win, and a probe that fails when the race does not occur is just another
  // flake. The drop rate across iterations is read from the attachments.
  expect(posted("bravo two")).toBe(!p.clicks[1].prevented);
});

/**
 * The other side of the same refusal: it is correct, and until now it was also
 * completely silent. A member types, presses Save while the previous save is
 * still going, and the click does nothing observable — no POST, no error, and
 * the textarea still holds the text, so there is nothing on screen that differs
 * from a successful save. `docs/e2e-flake-triage.md` costed this out and the
 * answer was to tell them, at this one call site, via `useSubmitGuard`'s
 * `onRefused`.
 *
 * The drop is forced with a route delay rather than raced. The test above
 * deliberately refuses to assert that press 2 was dropped, because whether it
 * loses the race is the thing it samples; here the drop is the precondition,
 * not the finding, so holding the first POST open removes the race instead of
 * sampling it. The guard latches on the synchronous ref in press 1's own
 * handler, so the refusal does not even depend on React having committed
 * `pending` yet.
 *
 * The notice deliberately outlives the in-flight save. Once press 1 settles the
 * refused text is still unsaved, so "press Save again" is still the correct
 * instruction — and it is asserted after the settle for exactly that reason, to
 * pin behaviour that a "clear it when pending goes false" refactor would look
 * like a tidy-up while quietly stranding the member's typing.
 */
test("a press refused mid-flight says so, and keeps saying so until it is saved", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Refused",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Refused roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.getByRole("heading", { name: "Refused roam" })).toBeVisible();

  const notes = page.getByRole("textbox", { name: "operation notes" });
  const save = page.getByRole("button", { name: "Save notes" });
  const status = page.locator(".notes-form__saved");

  // Held open, not slowed down for its own sake: this is what guarantees press 2
  // lands while press 1 is still in flight. Only POSTs are delayed, so the
  // navigation and RSC fetches around them are untouched.
  await page.route("**/payouts/**", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise((r) => setTimeout(r, 1000));
    await route.continue();
  });

  await notes.fill("alpha one");
  await save.click();

  await notes.fill("bravo two");
  await save.click();
  await expect(status).toHaveText("· still saving — press Save again");

  // Press 1 lands. The notice stays, because "bravo two" is still not saved.
  await expect(save).toHaveAttribute("aria-busy", "false");
  await expect(status).toHaveText("· still saving — press Save again");

  // Pressing again is what the notice asked for, and it has to actually work.
  await save.click();
  await expect(status).toHaveText("· saved");

  const stored = await db
    .select()
    .from(payoutOperation)
    .where(eq(payoutOperation.name, "Refused roam"))
    .then(([row]) => row.notes);
  expect(stored).toBe("bravo two");
});

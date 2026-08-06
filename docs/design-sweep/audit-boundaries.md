# audit — the boundary states

Register: **product**. Surfaces: `src/app/error.tsx`, `src/app/not-found.tsx`,
`src/app/payouts/[id]/not-found.tsx`, and the route-transition gap left by the
zero `loading.tsx` files under `src/app/`.

## Findings

### 1. "Try again" may be structurally incapable of clearing a server-side error, and nothing tests that it can

- **Severity:** serious
- **Where:** `src/app/error.tsx:281-292`; `e2e/error-boundary.spec.ts:96-141`
- **Cost:** A member whose page fell over on a transient DB hiccup presses the page's only action, watches the same error come straight back, presses it twice more, and concludes the tool is dead — when the underlying fault had already cleared.
- **Principle:** none (correctness of the page's one control)
- **Fix:** React's error-boundary `reset()` only clears the boundary's own error state and re-renders the children it already holds; for a throw that originated in a Server Component, those children are the errored RSC payload, so the re-render re-throws with no round trip. The standard remedy is to invalidate the router cache in the same transition. `clear-stale-query.tsx:54` already establishes `useRouter()` as an in-repo pattern:

  ```tsx
  const router = useRouter();
  // …
  onClick={() =>
    startRetry(() => {
      router.refresh();
      reset();
    })
  }
  ```

  Before changing anything, add the test that decides it — the one shape `e2e/error-boundary.spec.ts` deliberately never runs. Every existing retry test keeps the table renamed away so the retry is *guaranteed* to fail; none restores it first. The missing case:

  ```ts
  await breakPayoutsList(async () => {
    await page.goto("/payouts");
    await expect(page.getByRole("heading", { name: "Something broke" })).toBeVisible();
  }); // table is back
  await page.getByRole("button", { name: /Try again/ }).click();
  await expect(page.getByRole("heading", { name: "Payouts" })).toBeVisible();
  ```

  If that passes as written, this finding is void and the test is still worth keeping. See also *Could not evaluate* — `node_modules` is absent in this worktree, so I could not read Next's boundary implementation, and `package.json` pins `next ^16.3.0` while `not-found.tsx:20` records that the lockfile disagrees.

### 2. The sentence that exists to stop a duplicate write is never announced

- **Severity:** serious
- **Where:** `src/app/error.tsx:170-174` (the lede), `198` (`live={false}`), `_components/focus-heading.tsx:50-64`
- **Cost:** A screen-reader user who just pressed a save or a tier change hears exactly "Something broke, heading level one" and nothing else, so the warning to check whether the write already landed before sending it again never reaches the one person who cannot see it sitting an inch below.
- **Principle:** WCAG 4.1.3 Status Messages / 1.3.1 — and `e2e/error-boundary.spec.ts:260-283`, which pins that lede as the fix for a copy bug about exactly this
- **Fix:** The `live={false}` argument at `error.tsx:189-197` is right and should not be reversed — an assertive region rendering in the same commit as the focus move does preempt the heading. But the conclusion drawn from it is that the heading alone is enough, and the heading is two words. Give the h1 the lede as its accessible *description*, which is announced after the name on focus in NVDA, JAWS and VoiceOver, with no live region and no change to announcement order:

  ```tsx
  <FocusHeading describedBy="err-lede">Something broke</FocusHeading>
  <p className="page__lede" id="err-lede">…</p>
  ```

  with `FocusHeading` forwarding an optional `describedBy` to `aria-describedby` on the `h1`. This is worth doing only on `error.tsx`; the two 404 headings say their whole meaning in the heading text ("No such operation") and need nothing added.

  Note that the server-action path is the one that depends on this entirely: no document load and no pathname change, so Next's `AppRouterAnnouncer` never fires and `FocusHeading` is the sole announcement. A hard navigation into the boundary is announced twice over and is fine either way.

### 3. A retry that *succeeds* is silent and drops focus to `<body>`

- **Severity:** moderate
- **Where:** `src/app/error.tsx:281-292`; the mechanism is described at `focus-heading.tsx:20-23`
- **Cost:** A screen-reader user presses Try again, the page comes back working, and they hear nothing at all — the button they were on has been unmounted, focus is at the top of the document, and the only way to learn whether anything happened is to Tab through the whole page.
- **Principle:** none
- **Fix:** The file reasoned carefully about the *failed* retry (`error.tsx:274-280`: the remount re-runs `FocusHeading`, which re-announces) and left the success path with nothing, even though success is the outcome the control exists for. On success the boundary unmounts and cannot announce anything from inside itself, so the handoff has to be queued from the unmount:

  ```tsx
  const attempted = useRef(false);
  useEffect(
    () => () => {
      if (!attempted.current) return;
      requestAnimationFrame(() => document.getElementById("main")?.focus());
    },
    [],
  );
  ```

  set `attempted.current = true` in the click handler. Every page in the app renders `<main id="main" tabIndex={-1}>`, so the restored page has a focusable target at the top of its content — the same place the skip link lands. This is invisible to a sighted user and is the whole of the arrival signal for a screen-reader one. It is currently unreachable if finding 1 holds; fixing 1 exposes it.

### 4. Two of the four soft navigations have no in-flight signal, and one of them is the one `pending-link.tsx` claims to cover

- **Severity:** moderate
- **Where:** `src/app/payouts/page.tsx:96` and `:201`; the claim is at `src/app/payouts/pending-link.tsx:9-12`
- **Cost:** A member who has paged to the end of the operations list clicks "Back to the latest operations", the page does not change for the length of the list fan-out, and — by the exact mechanism `pending-link.tsx:13` writes down — they click it again.
- **Principle:** WCAG 4.1.3; and `pending-link.tsx`'s own stated contract
- **Fix:** `pending-link.tsx` says "The three soft navigations in the app are all on `/payouts` — the New operation control, every operation name in the list, and the empty state's way back." There are four call sites and only two are `PendingLink`. `page.tsx:201` **is** the empty state's way back, named in that sentence, and it is a bare `<Link>`. `page.tsx:96` (the lede's link to `/account`, one of the heaviest fan-outs in the app) is the fourth. Swap both to `PendingLink`; the component already takes `className` and children and needs no change. Then the docblock's count is true and there is no soft navigation in the app without a mark.

  If either is deliberately excluded, the docblock has to say so — as written it asserts coverage that does not exist, and the next reader will trust it.

### 5. The escalation block has no ground of its own, contradicting its own comment and DESIGN.md's Field idiom

- **Severity:** moderate
- **Where:** `src/app/globals.css:2044-2056`; comment at `:2040-2043`; `error.tsx:243-249`
- **Cost:** A member told to copy a block is looking for a block, and the only thing separating it from the prose above it is a hairline at 1.76:1 — so on a 1am monitor the record reads as three more lines of page and the drag either starts too high or is never attempted.
- **Principle:** DESIGN.md `--hull` = "Panels, table headers, **inset regions**"; DESIGN.md "**Field** — `--void` ground inset into `--hull`, `--rule-strong` border"
- **Fix:** The comment says "Inset into `--hull` like a field"; the rule sets `background: var(--void)` — the same value as the page ground, so it is inset into nothing. Measured against `--void`: the ground differs by 1.00:1 and the `--rule` border by 1.76:1. This has been the case since the block was introduced (`d32f9ab`), so it is a value that never matched its own comment, not a later drift. Take `background: var(--hull)`, which is the token DESIGN.md assigns to inset regions and gives a real ground change (1.10:1, the same separation the app's table headers and form panels already read as a surface) plus the border. If the `--void` ground is wanted instead, then the DESIGN.md Field idiom requires `border: 1px solid var(--rule-strong)` (4.11:1 against `--void`) so the edge alone can carry it — but do not keep both `--void` and `--rule`.

  For reference, everything else on this surface measures clean and needs no change: `--ink` on the `notice--bad` ground is 14.24:1, the `!` glyph in `--signal-bad` on it is 5.40:1, `--ink-dim` in the escalation is 9.57:1, and `--ink-faint` on the busy button's `--hull-hi` is 4.85:1, matching the number `globals.css:1547` claims exactly.

### 6. The escalation record loses its label column when it wraps at 320px

- **Severity:** minor
- **Where:** `src/app/globals.css:2044-2056`
- **Cost:** A member on a phone reading the record back to an admin sees a fourth line with no label in front of it and reads the tail of the route as if it were a separate value.
- **Principle:** none
- **Fix:** It does not overflow — `white-space: pre-wrap` plus `overflow-wrap: anywhere` is correct and the 320px reflow requirement is met. But at ≤40rem `.page` drops to `--s-4` padding, leaving ~288px, and `--t-data` mono fits roughly 34 characters; `page    /payouts/<uuid>` is 53. The continuation wraps to column 0, into the label column. A hanging indent aligns wrapped text under the value it belongs to and changes nothing at wider widths or in the copied text (`pre-wrap` wrapping is visual only, so the paste is already correct):

  ```css
  padding-left: calc(var(--s-4) + 8ch);
  text-indent: -8ch;
  ```

  8ch is the width of the label column the three lines already use.

## What is good and must survive

- **The "no `loading.tsx`" gap is much smaller than it looks, and a fix pass must not close it the obvious way.** Every link in `SiteHeader` is a plain `<a href>`, so a nav click is a full document load: the browser supplies its own progress indicator and the arrival is announced by the document. There is no announcement hole on nav. The only soft navigations in the app are the four on `/payouts`, and their arrival *is* announced — `AppRouterAnnouncer` portals `document.title` into an assertive region on pathname change. What is missing is only the wait, on the two links in finding 4. Adding `loading.tsx` would be strictly worse and `pending-link.tsx:18-23` already argues why: `SiteHeader` is rendered per-page with no `payouts/layout.tsx` to hold it, so a suspense fallback blanks the chrome along with the content.
- `.link-pending` animating 1 → 0.35 → 1 rather than starting dim, so the global `prefers-reduced-motion` freeze leaves a *visible* mark. That is a subtle property and a "simplify the keyframe" pass would delete it.
- `viewport.themeColor: "#080f1f"` is `--void` converted exactly (1.002:1 — identical). Any future token change to `--void` has to move this hex with it, or the mobile browser chrome seams against the page.
- `FocusHeading` being the mechanism rather than `AppRouterAnnouncer`, with the reason written down (`focus-heading.tsx:30-37`): the announcer's `h1` fallback is a race, and the server-action path into `error.tsx` involves no pathname change at all, so the announcer never fires there. Focus is the only deterministic half.
- The `sectionFor()` honesty argument (`error.tsx:58-79`) and the deliberate divergence from `not-found.tsx`'s minimal nav. The two files look inconsistent and are not; a "unify these" pass would break one of them.
- `error.tsx`'s Try again is the one place where the absence of `useSubmitGuard` is correct: it is a `type="button"` with no form (the guard requires `e.currentTarget.form` and would no-op anyway), and `reset()` is an idempotent client state clear with no side effect, so a double press costs nothing. Do not add the guard here by symmetry with `Submit`.
- The `<pre>` deliberately *not* taking `user-select: all` (`globals.css:2036-2038`) — the digest alone is the most likely single-line copy.
- `payouts/[id]/page.tsx`'s `generateMetadata` returning "No such operation" for the same lookup that returns null. That is what makes the missing `metadata` export on the segment 404 correct rather than a hole, and it only works because both callers share one `cache()`d loader.

## Could not evaluate

- **Whether `reset()` re-fetches server data on Next 16.3.** `node_modules` is not installed in this worktree, so I could not read the boundary implementation, and no dev server was permitted. Finding 1 rests on the framework behaviour rather than on anything observed here, which is why the fix leads with the test rather than the code change. That test is decisive and cheap.
- **Whether `aria-describedby` on a programmatically focused `h1` is announced in the corp's actual screen readers.** The behaviour is consistent across NVDA, JAWS and VoiceOver in my experience but is a runtime property; the e2e suite has no AT harness and no `jsdom`, so finding 2's fix can be pinned for the attribute's presence but not for what is spoken.
- **Safe-area insets in landscape on a notched phone.** `layout.tsx` declares `themeColor` and `colorScheme` but no `viewport-fit: cover`, and `globals.css` uses no `env(safe-area-inset-*)`. At ≤40rem `.page` has 16px side padding, less than a typical 44px landscape inset, so the escalation record's left edge would sit under the notch. I could not judge whether landscape phone use is real for this product — DESIGN.md's driving scene is a desktop alt-tab at 1am, which argues it is not, and this is a whole-app concern rather than a boundary one.

## Contested

Nothing on the settled list. The two omissions named in the preamble both check
out on inspection rather than on assertion: `global-error.tsx` genuinely has no
failure path to catch given `RootLayout` is a `<body>` plus build-time font
registration, and the segment 404's missing `metadata` is covered from the other
end by `generateMetadata` in `page.tsx`, verified at `payouts/[id]/page.tsx:92-101`.

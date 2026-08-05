# Admin accounts: Discord link/unlink adjacency

Separate PR from the "Your account" page work. Do not touch `src/app/account/`.

## Why

An `impeccable critique` of the member-facing account page found that
`.inline-pair` (`src/app/globals.css:2485-2489`) sets `gap: var(--s-1)` = 4px,
placing a destructive control 4px from an inert status token. The parent
`.facts__lead` uses `var(--s-3)` = 12px, so the destructive control sits three
times closer to the status label on its left than to anything on its right.

Both elements also render in the same register: `.st`
(`globals.css:1226-1236`) and `.btn--micro` (`globals.css:1639-1644`) are both
monospace, uppercase, 11px, letter-spaced. They do not merely sit close, they
read as one object with two halves.

The admin accounts table has the identical construction at
`src/app/admin/accounts/page.tsx:500-511`.

## Scope

1. **Widen the separation** between the `linked` Status and the `unlink`
   `ConfirmSubmit` in the Discord cell. Prefer fixing `.inline-pair` centrally
   (`--s-1` to `--s-3`) if that reads correctly at every other call site; grep
   for `inline-pair` first and check each one. If a central change regresses
   another site, scope the change to the Discord cell instead and record why.

2. **Check convention consistency** across the row's destructive controls. The
   admin unlink correctly passes both `restName` and `confirmName`
   (`admin/accounts/page.tsx:507-508`); verify the surrounding row controls
   match that convention.

3. **Consider an `aria-describedby` consequence.** The member page carries one
   (`account/page.tsx:305, 319-322`) because the unlink enqueues a deprovision
   that strips every managed role (`jobs/discord-roles.ts:79`). The admin is
   disconnecting *someone else's* Discord, so the consequence is arguably more
   important here, and it is currently absent. If added, keep it under 15 words
   and reveal it visually only when armed.

## Explicitly out of scope

- **Do not make the `linked` Status clickable.** A status token that becomes
  interactive contradicts the value/control split argued at
  `account/page.tsx:410-416`, which resolved the same question in the opposite
  direction and for good reason.
- **Do not add a modal or tooltip.** `ConfirmSubmit` already arms on first press
  and submits only on second, with Escape, blur and pointer-leave all disarming
  (`src/app/_components/confirm-submit.tsx:141-178`). A modal would be a third
  interruption layer on a double-guarded action, is the shared design laws'
  named anti-pattern, and `confirm-submit.tsx:47-48` already calls
  `window.confirm()` a banned reflex in this codebase.
- Anything in `src/app/account/`. That is the sibling PR.

## Constraints

- The admin table is scanned, not read (PRODUCT.md principle 3: "Scanning is the
  primary act"). Row height is expensive; do not add a line of prose per row.
- Rows must stay usable at 320px inside the `Scroller`.
- `.btn--micro` is 28px by deliberate tradeoff (`globals.css:1635-1638`): over
  the 24px WCAG 2.5.8 AA minimum, under AAA's 44px, because a control set on
  every row cannot carry 44px without the table growing past a screenful. Do not
  "fix" this without reading that comment.

## Verification

Cite actual output, per the project working agreement:

- `npm run format:check`
- `npm run typecheck`
- `npm test`
- `npm run test:e2e` if any admin accounts spec touches the Discord cell
- `code-reviewer` before opening the PR

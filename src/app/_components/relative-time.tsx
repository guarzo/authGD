"use client";

import { useEffect, useState } from "react";
import { formatAgo, formatDeadline } from "./format-ago";

/**
 * The sync page is server-rendered and never refreshes, so a server-computed
 * "3s ago" would sit there claiming freshness for as long as the tab stays
 * open. Recompute on the client instead. `initial` is the server's answer, so
 * the first paint matches the HTML and there is no hydration mismatch; the
 * ticking starts after mount.
 *
 * formatAgo lives in its own module rather than here: a "use client" module's
 * exports cannot be called from a server component, only rendered.
 */

/**
 * One 30-second timer for the whole document, not one per instance.
 *
 * The sync page mounts up to 42 of these — seven summary rows plus five table
 * rows per open job — and neither `display: none` (the `.only-narrow` stamp is
 * hidden above 40rem) nor a collapsed `<details>` unmounts a React subtree, so
 * every one of them was ticking and re-rendering, most of them behind
 * `display: none`. It is a small cost in absolute terms, but it is background
 * work on the page that specifically argues against moving under its reader.
 *
 * The interval exists only while something is subscribed, so a page with no
 * relative times on it holds no timer. Sharing the phase also means the whole
 * page's ages step together rather than at 42 unrelated offsets.
 */
const subscribers = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

function subscribe(tick: () => void): () => void {
  subscribers.add(tick);
  ticker ??= setInterval(() => {
    // Per-subscriber try/catch, because sharing the loop also shares the
    // failures: a throw aborts the iteration, and `Set` iterates in insertion
    // order, so one bad subscriber would freeze every timestamp registered
    // after it — on every subsequent tick, not once. The per-instance timers
    // this replaced isolated that by construction; the shared one has to say
    // so. Nothing reachable throws today (`formatAgo` returns a string for a
    // malformed instant rather than raising), which is exactly why the guard
    // has to be here rather than assumed.
    for (const fn of subscribers) {
      try {
        fn();
      } catch {
        // A stalled clock beside a working one; not worth taking the rest down.
      }
    }
  }, 30_000);
  return () => {
    subscribers.delete(tick);
    if (subscribers.size === 0 && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

/**
 * `countdown` picks the tense, and it has to be a prop rather than a formatter
 * argument: this is a "use client" boundary, so a server component cannot hand
 * a function across it. It also cannot be inferred from the instant being in
 * the future — fuel that has already run out is a past instant that still
 * belongs to the countdown grammar ("expired 2d ago", not "2d ago").
 *
 * The ticker matters as much as the first paint here. It recomputes from
 * scratch every 30s, so a countdown rendered correctly on the server but
 * ticked with `formatAgo` would sit right for half a minute and then collapse
 * back to "0s ago" on its own.
 */
export function RelativeTime({
  iso,
  initial,
  countdown = false,
  pastVerb,
}: {
  iso: string | null;
  initial: string;
  countdown?: boolean;
  pastVerb?: string;
}) {
  const [text, setText] = useState(initial);

  useEffect(() => {
    if (!iso) return;
    const tick = () =>
      setText(
        countdown
          ? formatDeadline(iso, Date.now(), pastVerb)
          : formatAgo(iso, Date.now()),
      );
    tick();
    return subscribe(tick);
  }, [iso, countdown, pastVerb]);

  // No instant, no `<time>`: a `<time>` with no `datetime` takes its machine
  // value from its own text, and "never" is not one. The sync strip reaches
  // this whenever a scheduled job has no runs at all. The shared `.ago` class
  // is what layout hangs off, so a row that lost its `<time>` keeps its
  // position in the strip's grid.
  if (!iso) return <span className="ago dim mono">{text}</span>;

  return (
    <time className="ago dim mono" dateTime={iso}>
      {text}
    </time>
  );
}

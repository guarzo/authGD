"use client";

import { useEffect, useState } from "react";
import { formatAgo } from "./format-ago";

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
    for (const fn of subscribers) fn();
  }, 30_000);
  return () => {
    subscribers.delete(tick);
    if (subscribers.size === 0 && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

export function RelativeTime({ iso, initial }: { iso: string | null; initial: string }) {
  const [text, setText] = useState(initial);

  useEffect(() => {
    if (!iso) return;
    const tick = () => setText(formatAgo(iso, Date.now()));
    tick();
    return subscribe(tick);
  }, [iso]);

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

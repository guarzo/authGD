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
export function RelativeTime({ iso, initial }: { iso: string | null; initial: string }) {
  const [text, setText] = useState(initial);

  useEffect(() => {
    if (!iso) return;
    const tick = () => setText(formatAgo(iso, Date.now()));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [iso]);

  return (
    <time className="dim mono" dateTime={iso ?? undefined}>
      {text}
    </time>
  );
}

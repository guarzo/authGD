import { NextResponse, type NextRequest } from "next/server";

// Next excludes this whole prefix (including /_nextfoo) from custom redirects.
// Match the prefix, not a final slash: Next rechecks matchers after stripping it.
export const config = { matcher: "/:path(_[nN][eE][xX][tT].*)" };

export function proxy(request: NextRequest) {
  const url = new URL(request.url);
  // Image/data handling can invoke Proxy outside the matcher. Never redirect
  // nonmatching or already-canonical paths, and leave Fleet to its own handlers.
  if (!/^\/_next/i.test(url.pathname) || !url.pathname.endsWith("/"))
    return NextResponse.next();
  url.pathname = url.pathname.slice(0, -1);
  // Match the built-in redirect's encodeURIComponent query spelling and keep
  // duplicate values, rather than form-query encoding (+, %7E).
  url.search = Array.from(
    url.searchParams,
    ([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
  ).join("&");
  return NextResponse.redirect(url, 308);
}

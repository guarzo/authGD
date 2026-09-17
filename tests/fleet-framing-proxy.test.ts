import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { expect, it } from "vitest";
import { config, proxy } from "@/proxy";

it.each([
  ["/_next/image/", "/_next/image"],
  ["/_next/static/chunks/missing.js/", "/_next/static/chunks/missing.js"],
  ["/_nextfoo/", "/_nextfoo"],
  ["/_NeXtfoo/", "/_NeXtfoo"],
  ["/_next/", "/_next"],
  [
    "/_nextfoo/?q=space+value&mark=%7E&tag=a&tag=b",
    "/_nextfoo?q=space%20value&mark=~&tag=a&tag=b",
  ],
  [
    "/_next/static/%E2%82%AC%20name.js/?q=space%20value&mark=~&tag=a&tag=b",
    "/_next/static/%E2%82%AC%20name.js?q=space%20value&mark=~&tag=a&tag=b",
  ],
])("redirects the excluded prefix %s without decoding the path", (path, location) => {
  expect(unstable_doesMiddlewareMatch({ config, url: path })).toBe(true);
  const response = proxy(new NextRequest(`https://auth.example${path}`));
  expect(response.status).toBe(308);
  expect(response.headers.get("location")).toBe(`https://auth.example${location}`);
  expect(response.headers.has("x-middleware-next")).toBe(false);
});

it.each([
  "/api/fleet/v2/session/",
  "/api/fleet/v2/pairing-requests/",
  "/account/",
  "/other/_next/image/",
  "/_next/image",
  "/_next/image?url=%2Flogo.png&w=64&q=75",
  "/_next/static/chunks/missing.js",
  "/_nextfoo",
  "/",
])("passes %s through even if Next invokes Proxy despite the matcher", (path) => {
  const response = proxy(new NextRequest(`https://auth.example${path}`));
  expect(response.headers.get("x-middleware-next")).toBe("1");
  expect(response.headers.has("location")).toBe(false);
});

it.each(["/api/fleet/v2/session/", "/account/", "/other/_next/image/", "/"])(
  "matcher excludes unrelated %s",
  (path) => {
    expect(unstable_doesMiddlewareMatch({ config, url: path })).toBe(false);
  },
);

it("keeps HEAD redirect semantics without a response body", () => {
  const response = proxy(
    new NextRequest("https://auth.example/_nextfoo/?v=one", { method: "HEAD" }),
  );
  expect(response.status).toBe(308);
  expect(response.headers.get("location")).toBe("https://auth.example/_nextfoo?v=one");
  expect(response.body).toBeNull();
});

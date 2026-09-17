import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Fleet wire paths must be rejected, not redirected before route validation.
  // The custom rule and src/proxy.ts preserve non-Fleet slash removal together;
  // the Proxy handles only the /_next prefix excluded from custom redirects.
  skipTrailingSlashRedirect: true,
  // Otherwise Next strips query keys (e.g. _rsc) before Proxy can preserve them.
  skipProxyUrlNormalize: true,
  redirects() {
    return Promise.resolve([
      {
        source: "/:path((?!api/fleet(?:/|$)).+)/",
        destination: "/:path",
        permanent: true,
      },
    ]);
  },
};

export default nextConfig;

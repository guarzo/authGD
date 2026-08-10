import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import { BrandProvider } from "@/app/_components/brand-context";
import { getConfig } from "@/config";
import "./globals.css";

// Self-hosted at build time by next/font — no runtime request to Google, no
// layout shift, and no npm dependency beyond Next itself.
const sans = Archivo({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-mono",
  display: "swap",
});

// Reading config in generateMetadata() and in the layout body makes both
// request-time work. Declared for the same reason login/page.tsx documents:
// the ordering is load-bearing and undeclared otherwise, and a Docker build
// has no config env present.
export const dynamic = "force-dynamic";

// Synchronous: this reads config, which is a plain in-process lookup. Next
// accepts either form, and an `async` with nothing to await trips
// @typescript-eslint/require-await.
export function generateMetadata(): Metadata {
  const { brand } = getConfig();
  return {
    title: {
      default: `${brand.name} · ${brand.tagline}`,
      template: `%s · ${brand.name}`,
    },
    description: `Corporation auth for ${brand.name}.`,
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "any" },
        { url: "/icon.png", type: "image/png", sizes: "512x512" },
      ],
      apple: "/apple-icon.png",
    },
  };
}

export const viewport = {
  // Must equal the rendered value of `--void` (globals.css), which is what
  // `body` paints. This is a hardcoded duplicate of that token — the viewport
  // meta cannot read a custom property — so it has to be updated by hand
  // whenever the ground moves, and it was not: it still held `#080f1f`, a
  // navy from a palette the app no longer uses, while `--void` is
  // `oklch(0.145 0 58)`, chroma 0. On mobile that painted a blue browser
  // chrome directly above a neutral page.
  //
  // `oklch(0.145 0 58)` is achromatic, so all three channels are equal:
  // 0.145³ = 0.00304862 in linear light, which is below the 0.0031308 sRGB
  // gamma knee, so the linear segment applies — 12.92 × 0.00304862 × 255 =
  // 10.04, i.e. 0x0a.
  themeColor: "#0a0a0a",
  colorScheme: "dark" as const,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const { brand } = getConfig();
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <BrandProvider
          value={{ name: brand.name, tagline: brand.tagline, markUrl: brand.markUrl }}
        >
          {children}
        </BrandProvider>
      </body>
    </html>
  );
}

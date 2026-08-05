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

export async function generateMetadata(): Promise<Metadata> {
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
  themeColor: "#080f1f",
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

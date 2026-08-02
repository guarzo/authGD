import type { ReactNode } from "react";

export const metadata = { title: "authGD" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

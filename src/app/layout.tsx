import type { ReactNode } from "react";
import "./globals.css";
import { AppearanceProvider } from "../components/appearance";

export const metadata = { title: "AIRA Nexus" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <AppearanceProvider>{children}</AppearanceProvider>
      </body>
    </html>
  );
}

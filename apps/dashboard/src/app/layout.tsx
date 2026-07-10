import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppProviders } from "../providers/app-providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Workforce OS",
  description: "Enterprise AI workforce operations platform"
};

type RootLayoutProperties = Readonly<{
  children: ReactNode;
}>;

export default function RootLayout({ children }: RootLayoutProperties) {
  return (
    <html lang="en">
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}

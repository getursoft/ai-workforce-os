import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, Poppins } from "next/font/google";
import { AppProviders } from "../providers/app-providers";
import "./globals.css";

// Same brand typography as the marketing site (Inter for body copy, Poppins for headings) so the
// dashboard app reads as a continuation of the same product, not a different one after login.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  display: "swap"
});

export const metadata: Metadata = {
  title: "AI Workforce OS",
  description: "Enterprise AI workforce operations platform"
};

type RootLayoutProperties = Readonly<{
  children: ReactNode;
}>;

export default function RootLayout({ children }: RootLayoutProperties) {
  return (
    <html lang="en" className={`${inter.variable} ${poppins.variable}`}>
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}

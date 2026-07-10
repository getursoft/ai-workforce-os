"use client";

import type { ReactNode } from "react";
import { AuthProvider } from "../features/auth/auth-provider";

export function AppProviders({ children }: Readonly<{ children: ReactNode }>) {
  return <AuthProvider>{children}</AuthProvider>;
}

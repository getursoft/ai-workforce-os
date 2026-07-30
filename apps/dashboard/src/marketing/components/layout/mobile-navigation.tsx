"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { primaryNav, topLevelNav } from "@/content/navigation";
import { useAuth, useLogout } from "../../../features/auth/auth-provider";

export function MobileNavigation({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { state } = useAuth();
  const logout = useLogout();

  async function handleLogout() {
    onClose();
    try {
      await logout();
    } finally {
      router.replace("/login");
    }
  }

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Mobile navigation">
      <div className="absolute inset-0 bg-navy/60" onClick={onClose} aria-hidden="true" />
      <div className="absolute inset-y-0 right-0 flex w-full max-w-sm flex-col overflow-y-auto bg-royal p-6">
        <div className="flex items-center justify-between">
          <span className="text-lg font-bold text-white">Menu</span>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring rounded-md p-2 text-white"
            aria-label="Close menu"
          >
            <X className="h-6 w-6" aria-hidden="true" />
          </button>
        </div>

        <div className="mt-6 flex flex-col gap-6">
          {primaryNav.map((column) => (
            <details key={column.label} className="group rounded-xl border border-white/10 bg-white/5">
              <summary className="focus-ring flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-white">
                {column.label}
                <span className="text-gold transition-transform group-open:rotate-180">⌄</span>
              </summary>
              <div className="flex flex-col gap-1 px-4 pb-3">
                {column.links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={onClose}
                    className="focus-ring rounded-md px-2 py-2 text-sm text-white/80 hover:bg-white/5 hover:text-white"
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            </details>
          ))}

          <div className="flex flex-col gap-1">
            {topLevelNav.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={onClose}
                className="focus-ring rounded-md px-4 py-3 text-sm font-semibold text-white hover:bg-white/5"
              >
                {link.label}
              </Link>
            ))}
            {state.isAuthenticated && (
              <Link
                href="/dashboard"
                onClick={onClose}
                className="focus-ring rounded-md px-4 py-3 text-sm font-semibold text-white hover:bg-white/5"
              >
                Dashboard
              </Link>
            )}
          </div>
        </div>

        <div className="mt-auto flex flex-col gap-3 pt-6">
          {state.isAuthenticated ? (
            <>
              <Link
                href="/dashboard"
                onClick={onClose}
                className="focus-ring flex h-11 items-center justify-center rounded-xl bg-saffron px-4 text-center text-sm font-semibold text-white"
              >
                Dashboard
              </Link>
              <button
                type="button"
                onClick={handleLogout}
                className="focus-ring flex h-11 items-center justify-center rounded-xl border border-white/30 px-4 text-center text-sm font-semibold text-white"
              >
                Logout
              </button>
            </>
          ) : (
            <>
              <Link
                href="/login"
                onClick={onClose}
                className="focus-ring flex h-11 items-center justify-center rounded-xl border border-white/30 px-4 text-center text-sm font-semibold text-white"
              >
                Log in
              </Link>
              <Link
                href="/book-demo"
                onClick={onClose}
                className="focus-ring flex h-11 items-center justify-center rounded-xl bg-saffron px-4 text-center text-sm font-semibold text-white"
              >
                Book a Demo
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

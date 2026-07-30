"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Menu } from "lucide-react";
import { LogoMark } from "@/components/shared/logo-mark";
import { primaryNav, topLevelNav } from "@/content/navigation";
import { siteConfig } from "@/content/site";
import { MobileNavigation } from "./mobile-navigation";
import { useAuth, useLogout } from "../../../features/auth/auth-provider";
import { displayName } from "../../../components/layout/dashboard-shell.logic";
import { Avatar, DropdownMenu } from "../../../components/ui";

export function PublicHeader() {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const router = useRouter();
  const { state } = useAuth();
  const logout = useLogout();
  const currentUserName = displayName(state.user?.firstName, state.user?.lastName);

  async function handleLogout() {
    try {
      await logout();
    } finally {
      router.replace("/login");
    }
  }

  return (
    <header className="sticky top-0 z-40 border-b-2 border-[#062B73] bg-royal">
      <div className="mx-auto flex h-18 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link href="/" className="focus-ring flex items-center gap-3">
          <LogoMark className="h-10 w-10 flex-shrink-0" />
          <span className="flex flex-col leading-tight">
            <span className="text-lg font-bold tracking-tight text-white">{siteConfig.name}</span>
            <span className="hidden text-[11px] font-medium text-gold sm:block">{siteConfig.tagline}</span>
          </span>
        </Link>

        <nav className="hidden items-center gap-6 lg:flex" aria-label="Primary">
          {primaryNav.map((column) => (
            <div
              key={column.label}
              className="relative"
              onMouseEnter={() => setOpenMenu(column.label)}
              onMouseLeave={() => setOpenMenu((current) => (current === column.label ? null : current))}
            >
              <button
                type="button"
                className="focus-ring relative flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium text-white/90 transition-colors after:absolute after:bottom-0 after:left-1/2 after:h-[2px] after:w-0 after:-translate-x-1/2 after:bg-saffron after:transition-all after:duration-[220ms] hover:text-white hover:after:w-5"
                aria-expanded={openMenu === column.label}
                aria-haspopup="true"
                onClick={() => setOpenMenu((current) => (current === column.label ? null : column.label))}
              >
                {column.label}
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              {openMenu === column.label && (
                <div className="absolute left-1/2 top-full w-80 -translate-x-1/2 pt-3">
                  <div className="grid gap-1 rounded-card border border-royal/10 bg-white p-3 shadow-card">
                    {column.links.map((link) => (
                      <Link
                        key={link.href}
                        href={link.href}
                        className="focus-ring flex flex-col rounded-xl px-4 py-2.5 transition-colors hover:bg-cream/70"
                        onClick={() => setOpenMenu(null)}
                      >
                        <span className="text-sm font-semibold text-ink">{link.label}</span>
                        {link.description && (
                          <span className="text-xs text-muted">{link.description}</span>
                        )}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
          {topLevelNav.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="focus-ring relative rounded-md px-3 py-2 text-sm font-medium text-white/90 transition-colors after:absolute after:bottom-0 after:left-1/2 after:h-[2px] after:w-0 after:-translate-x-1/2 after:bg-saffron after:transition-all after:duration-[220ms] hover:text-white hover:after:w-5"
            >
              {link.label}
            </Link>
          ))}
          {state.isAuthenticated && (
            <Link
              href="/dashboard"
              className="focus-ring relative rounded-md px-3 py-2 text-sm font-medium text-white/90 transition-colors after:absolute after:bottom-0 after:left-1/2 after:h-[2px] after:w-0 after:-translate-x-1/2 after:bg-saffron after:transition-all after:duration-[220ms] hover:text-white hover:after:w-5"
            >
              Dashboard
            </Link>
          )}
        </nav>

        <div className="hidden items-center gap-3 lg:flex">
          {state.isAuthenticated ? (
            <DropdownMenu
              triggerProps={{ "aria-label": "Account menu" }}
              trigger={<Avatar name={currentUserName} />}
            >
              <div className="dashboard-user-menu">
                <Link href="/dashboard">Dashboard</Link>
                <button type="button" className="dashboard-user-menu__logout" onClick={handleLogout}>
                  Logout
                </button>
              </div>
            </DropdownMenu>
          ) : (
            <>
              <Link href="/login" className="focus-ring rounded-md px-3 py-2 text-sm font-semibold text-white/90 hover:text-white">
                Log in
              </Link>
              <Link
                href="/book-demo"
                className="focus-ring inline-flex h-10 items-center gap-2 rounded-xl bg-saffron px-4 text-sm font-semibold text-white shadow-gold transition-colors hover:bg-[#d97b00]"
              >
                Book a Demo
              </Link>
            </>
          )}
        </div>

        <button
          type="button"
          className="focus-ring inline-flex items-center justify-center rounded-md p-2 text-white lg:hidden"
          aria-label="Open menu"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(true)}
        >
          <Menu className="h-6 w-6" aria-hidden="true" />
        </button>
      </div>

      <MobileNavigation open={mobileOpen} onClose={() => setMobileOpen(false)} />
    </header>
  );
}

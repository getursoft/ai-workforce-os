import Link from "next/link";
import { ChevronRight, Home } from "lucide-react";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mx-auto max-w-6xl px-6 pt-6">
      <ol className="flex flex-wrap items-center gap-2 text-sm text-white/70">
        <li className="flex items-center gap-2">
          <Link href="/" className="focus-ring flex items-center gap-1 hover:text-white" aria-label="Home">
            <Home className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </li>
        {items.map((item, i) => (
          <li key={item.label} className="flex items-center gap-2">
            <ChevronRight className="h-3.5 w-3.5 text-white/40" aria-hidden="true" />
            {item.href && i !== items.length - 1 ? (
              <Link href={item.href} className="focus-ring hover:text-white">
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-white">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

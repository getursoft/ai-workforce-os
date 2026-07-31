import Link from "next/link";
import { LinkedinIcon, TwitterIcon, YoutubeIcon } from "@/components/shared/social-icons";
import { LogoMark } from "@/components/shared/logo-mark";
import { siteConfig } from "@/content/site";
import { footerColumns } from "@/content/navigation";
import { footerBrand } from "@/content/footer";
import { NewsletterForm } from "@/components/forms/newsletter-form";

const columnGroups: { heading: string; links: { label: string; href: string }[] }[] = [
  { heading: "Product", links: footerColumns.product },
  { heading: "Solutions", links: footerColumns.solutions },
  { heading: "Resources", links: footerColumns.resources },
  { heading: "Company", links: footerColumns.company },
  { heading: "Legal", links: footerColumns.legal },
];

export function PublicFooter() {
  return (
    <footer className="relative overflow-hidden border-t border-gold/40 bg-royal text-white">
      <div className="relative mx-auto max-w-7xl px-4 pb-6 pt-6 sm:px-6 lg:px-8">
        <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr_1fr_1.2fr]">
          <div>
            <Link href="/" className="focus-ring flex items-center gap-3">
              <LogoMark className="h-11 w-11" />
              <span className="flex flex-col leading-tight">
                <span className="text-lg font-bold text-white">{siteConfig.name}</span>
                <span className="text-[11px] font-medium text-gold">{siteConfig.tagline}</span>
              </span>
            </Link>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-white/70">{footerBrand.description}</p>
            <div className="mt-4 flex items-center gap-3">
              <SocialIcon href={siteConfig.social.linkedin} label="LinkedIn">
                <LinkedinIcon className="h-4 w-4" aria-hidden="true" />
              </SocialIcon>
              <SocialIcon href={siteConfig.social.twitter} label="Twitter">
                <TwitterIcon className="h-4 w-4" aria-hidden="true" />
              </SocialIcon>
              <SocialIcon href={siteConfig.social.youtube} label="YouTube">
                <YoutubeIcon className="h-4 w-4" aria-hidden="true" />
              </SocialIcon>
            </div>
          </div>

          {columnGroups.map((group) => (
            <div key={group.heading}>
              <h3 className="text-xs font-semibold uppercase tracking-[0.15em] text-gold">{group.heading}</h3>
              <ul className="mt-3 space-y-2">
                {group.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className="focus-ring text-sm text-white/75 hover:text-white">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div>
            <h3 className="text-sm font-semibold text-white">{footerBrand.newsletter.heading}</h3>
            <p className="mt-2 text-sm leading-relaxed text-white/70">{footerBrand.newsletter.description}</p>
            <div className="mt-3">
              <NewsletterForm />
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-col items-center gap-3 border-t border-white/10 pt-4 text-xs text-white/60 sm:flex-row sm:justify-between">
          <p>&copy; {new Date().getFullYear()} {siteConfig.name}. All rights reserved.</p>
          <div className="flex flex-wrap items-center justify-center gap-5">
            {footerBrand.bottomLinks.map((link) => (
              <Link key={link.href} href={link.href} className="focus-ring hover:text-white">
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}

function SocialIcon({ href, label, children }: { href: string; label: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="focus-ring flex h-9 w-9 items-center justify-center rounded-full border border-white/20 text-white/80 transition-colors hover:border-gold hover:text-gold"
    >
      {children}
    </a>
  );
}

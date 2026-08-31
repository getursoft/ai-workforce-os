import type { Metadata } from "next";
import { siteConfig } from "@/content/site";

const baseUrl = `https://${siteConfig.domain}`;

interface MetadataInput {
  title: string;
  description: string;
  path: string;
  keywords?: string[];
  /** Omits this page from search results (still crawlable/linkable) — for utility pages like auth
   *  screens that offer nothing to searchers and would otherwise dilute crawl budget. */
  noIndex?: boolean;
  /** Set for blog posts / long-form content so social previews and crawlers see `og:type: article`
   *  with publish metadata, instead of the generic "website" type used everywhere else. */
  article?: { publishedTime: string; author?: string };
}

export function defaultMetadata({ title, description, path, keywords, noIndex, article }: MetadataInput): Metadata {
  const url = `${baseUrl}${path}`;

  return {
    metadataBase: new URL(baseUrl),
    title,
    description,
    keywords: keywords ?? [
      "Krevia.ai",
      "AI employees",
      "enterprise AI platform",
      "AI agents for business",
      "AI operating system",
    ],
    alternates: { canonical: path },
    ...(noIndex ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      title,
      description,
      url,
      siteName: siteConfig.name,
      type: article ? "article" : "website",
      images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: siteConfig.name }],
      ...(article
        ? { publishedTime: article.publishedTime, ...(article.author ? { authors: [article.author] } : {}) }
        : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/opengraph-image"],
    },
  };
}

/** Organization schema (JSON-LD) — rendered once, sitewide, in the root layout so every page is
 *  eligible for Google's knowledge-panel / sitelinks-search-box treatment without per-page setup. */
export function organizationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: siteConfig.name,
    url: baseUrl,
    description: siteConfig.description,
    email: siteConfig.contact.generalEmail,
    telephone: siteConfig.contact.phone,
    address: { "@type": "PostalAddress", streetAddress: siteConfig.contact.address },
    sameAs: Object.values(siteConfig.social),
  };
}

/** WebSite schema (JSON-LD) — distinct from Organization; lets Google associate the site itself
 *  (as opposed to the legal entity) with its name and canonical URL. */
export function websiteJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: siteConfig.name,
    url: baseUrl,
    description: siteConfig.description,
  };
}

/** Renders a `<script type="application/ld+json">` tag for the given structured-data object(s). */
export function JsonLd({ data }: { data: object | object[] }) {
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />
  );
}

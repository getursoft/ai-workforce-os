import type { Metadata } from "next";
import { siteConfig } from "@/content/site";

const baseUrl = `https://${siteConfig.domain}`;

interface MetadataInput {
  title: string;
  description: string;
  path: string;
  keywords?: string[];
}

export function defaultMetadata({ title, description, path, keywords }: MetadataInput): Metadata {
  const url = `${baseUrl}${path}`;

  return {
    metadataBase: new URL(baseUrl),
    title,
    description,
    keywords: keywords ?? [
      "AI Workforce OS",
      "AI employees",
      "enterprise AI platform",
      "AI agents for business",
      "AI operating system",
    ],
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      url,
      siteName: siteConfig.name,
      type: "website",
      images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: siteConfig.name }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/opengraph-image"],
    },
  };
}

import type { MetadataRoute } from "next";
import { siteConfig } from "@/content/site";
import { aiEmployees } from "@/content/ai-employees";
import { blogPosts } from "@/content/blog";

const baseUrl = `https://${siteConfig.domain}`;

const staticRoutes = [
  "/",
  "/platform",
  "/platform/capabilities",
  "/platform/knowledge",
  "/platform/integrations",
  "/platform/security",
  "/platform/analytics",
  "/meet-ai-employees",
  "/solutions",
  "/solutions/customer-service",
  "/solutions/operations",
  "/solutions/sales",
  "/solutions/marketing",
  "/solutions/hr",
  "/solutions/finance",
  "/solutions/it",
  "/solutions/travel",
  "/solutions/enterprise",
  "/solutions/startups",
  "/connect",
  "/customers",
  "/pricing",
  "/about",
  "/contact",
  "/book-demo",
  "/resources",
  "/resources/blog",
  "/resources/case-studies",
  "/resources/documentation",
  "/resources/help-centre",
  "/resources/faq",
  "/security",
  "/privacy",
  "/terms",
  "/cookies",
  "/login",
];

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const entries: MetadataRoute.Sitemap = staticRoutes.map((path) => ({
    url: `${baseUrl}${path}`,
    lastModified: now,
    changeFrequency: path === "/" ? "weekly" : "monthly",
    priority: path === "/" ? 1 : 0.7,
  }));

  for (const employee of aiEmployees) {
    entries.push({
      url: `${baseUrl}/meet-ai-employees/${employee.slug}`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.8,
    });
  }

  for (const post of blogPosts) {
    entries.push({
      url: `${baseUrl}/resources/blog/${post.slug}`,
      lastModified: new Date(post.publishedAt),
      changeFrequency: "yearly",
      priority: 0.5,
    });
  }

  return entries;
}

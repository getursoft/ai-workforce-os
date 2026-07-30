import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { blogPosts } from "@/content/blog";

export const metadata: Metadata = defaultMetadata({
  title: "Blog",
  description: "Perspectives on AI employees, governance and how teams put AI Workforce OS to work.",
  path: "/resources/blog",
});

export default function BlogListingPage() {
  return (
    <>
      <PageHero eyebrow="Blog" title="Ideas on AI Employees at Work" description="Practical perspectives from the AI Workforce OS team." />
      <section className="mx-auto max-w-5xl px-4 py-9 sm:px-6 lg:px-8">
        <div className="space-y-6">
          {blogPosts.map((post) => (
            <Link
              key={post.slug}
              href={`/resources/blog/${post.slug}`}
              className="focus-ring group block rounded-card border border-royal/10 bg-white p-6 shadow-soft transition-all hover:-translate-y-1 hover:shadow-card"
            >
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                <span className="rounded-full bg-cream px-3 py-1 font-semibold text-saffron">{post.category}</span>
                <span>{post.readTime}</span>
                <span>{new Date(post.publishedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</span>
              </div>
              <h2 className="mt-3 text-xl font-bold text-ink">{post.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">{post.excerpt}</p>
              <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-saffron">
                Read More <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </span>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}

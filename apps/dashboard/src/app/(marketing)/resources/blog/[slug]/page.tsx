import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { defaultMetadata } from "@/lib/seo";
import { Breadcrumb } from "@/components/shared/breadcrumb";
import { ButtonLink } from "@/components/shared/button-link";
import { blogPosts, getBlogPost } from "@/content/blog";

export function generateStaticParams() {
  return blogPosts.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const post = getBlogPost(slug);
  if (!post) return defaultMetadata({ title: "Blog", description: "Krevia.ai blog.", path: "/resources/blog" });
  return defaultMetadata({ title: post.title, description: post.excerpt, path: `/resources/blog/${post.slug}` });
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getBlogPost(slug);
  if (!post) notFound();

  return (
    <>
      <section className="relative overflow-hidden bg-royal pb-7 pt-6">
        <div className="absolute inset-0 watermark-mandala opacity-[0.05]" aria-hidden="true" />
        <Breadcrumb items={[{ label: "Blog", href: "/resources/blog" }, { label: post.title }]} />
        <div className="relative mx-auto mt-8 max-w-3xl px-6 text-center">
          <span className="inline-flex items-center rounded-full border border-gold/30 bg-white/5 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-gold">
            {post.category}
          </span>
          <h1 className="mt-6 text-3xl font-bold tracking-tight text-white sm:text-4xl">{post.title}</h1>
          <p className="mt-3 text-sm text-white/60">
            {new Date(post.publishedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} · {post.readTime}
          </p>
        </div>
      </section>

      <article className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="space-y-5 text-base leading-relaxed text-ink/90">
          {post.content.map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
        </div>

        <div className="mt-8 rounded-card border border-gold/30 bg-cream/60 p-8 text-center">
          <h2 className="text-xl font-bold text-ink">Ready to see this in practice?</h2>
          <div className="mt-5">
            <ButtonLink href="/book-demo" variant="primary">Book a Demo</ButtonLink>
          </div>
        </div>
      </article>
    </>
  );
}

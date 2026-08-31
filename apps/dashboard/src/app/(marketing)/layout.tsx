import { PageShell } from "@/components/layout/page-shell";
import { HeritageWatermark } from "@/components/shared/heritage-watermark";
import { ChatbotProvider } from "@/components/chatbot/chatbot-provider";
import { ChatbotWidget } from "@/components/chatbot/chatbot-widget";
import { JsonLd, organizationJsonLd, websiteJsonLd } from "@/lib/seo";

// Scoped to the (marketing) route group only — the root layout (shared with the authenticated
// dashboard and the auth screens) stays neutral, so nothing here changes how those existing pages look
// or behave. This is the merged app's public "front door".
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="marketing-shell min-h-screen bg-ivory font-sans text-ink antialiased">
      <JsonLd data={[organizationJsonLd(), websiteJsonLd()]} />
      <a
        href="#main-content"
        className="focus-ring sr-only rounded-md bg-royal px-4 py-2 text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50"
      >
        Skip to main content
      </a>
      <HeritageWatermark />
      <ChatbotProvider>
        <PageShell>{children}</PageShell>
        <ChatbotWidget />
      </ChatbotProvider>
    </div>
  );
}

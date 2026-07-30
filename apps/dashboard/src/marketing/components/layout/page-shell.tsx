import { PublicHeader } from "./public-header";
import { PublicFooter } from "./public-footer";
import { BottomRibbon } from "./bottom-ribbon";

export function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <PublicHeader />
      <main id="main-content" className="flex-1">
        {children}
      </main>
      <PublicFooter />
      <BottomRibbon />
    </div>
  );
}

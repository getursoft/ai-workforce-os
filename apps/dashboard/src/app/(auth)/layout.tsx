import { PublicHeader } from "@/components/layout/public-header";
import { PublicFooter } from "@/components/layout/public-footer";

// Wraps login/signup with the same marketing header/footer as the rest of the site, so the
// pre-authentication screens read as part of the same product rather than a separate, unbranded flow.
// The auth form/screen itself (components/auth/login-form.tsx etc.) is untouched.
//
// The "marketing-shell" class matters here, not just for looks: globals.css scopes its native
// button/select reset to ".marketing-shell button" (see the Tailwind-import comment at the top of that
// file) so it never touches the dashboard's own pages. Without this wrapper, PublicHeader's nav-dropdown
// buttons render with unstyled native browser chrome on this page, same bug as the marketing pages had
// before that reset existed.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="marketing-shell">
      <PublicHeader />
      {children}
      <PublicFooter />
    </div>
  );
}

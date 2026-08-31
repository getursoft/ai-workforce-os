import type { Metadata } from "next";
import { LoginForm } from "../../../components/auth/login-form";
import { defaultMetadata } from "@/lib/seo";

export const metadata: Metadata = defaultMetadata({
  title: "Login | Krevia.ai",
  description: "Sign in to Krevia.ai",
  path: "/login",
  noIndex: true
});

export default function LoginPage() {
  return (
    <main className="auth-screen">
      <LoginForm />
    </main>
  );
}

import type { Metadata } from "next";
import { ForgotPasswordForm } from "../../../components/auth/forgot-password-form";
import { defaultMetadata } from "@/lib/seo";

export const metadata: Metadata = defaultMetadata({
  title: "Forgot password | Krevia.ai",
  description: "Reset your Krevia.ai password",
  path: "/forgot-password",
  noIndex: true
});

export default function ForgotPasswordPage() {
  return (
    <main className="auth-screen">
      <ForgotPasswordForm />
    </main>
  );
}

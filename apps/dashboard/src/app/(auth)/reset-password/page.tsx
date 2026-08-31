import type { Metadata } from "next";
import { ResetPasswordForm } from "../../../components/auth/reset-password-form";
import { defaultMetadata } from "@/lib/seo";

export const metadata: Metadata = defaultMetadata({
  title: "Reset password | Krevia.ai",
  description: "Reset your Krevia.ai password",
  path: "/reset-password",
  noIndex: true
});

export default function ResetPasswordPage() {
  return (
    <main className="auth-screen">
      <ResetPasswordForm />
    </main>
  );
}

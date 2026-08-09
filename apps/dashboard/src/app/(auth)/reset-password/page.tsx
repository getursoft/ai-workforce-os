import type { Metadata } from "next";
import { ResetPasswordForm } from "../../../components/auth/reset-password-form";

export const metadata: Metadata = {
  title: "Reset password | Krevia.ai",
  description: "Reset your Krevia.ai password"
};

export default function ResetPasswordPage() {
  return (
    <main className="auth-screen">
      <ResetPasswordForm />
    </main>
  );
}

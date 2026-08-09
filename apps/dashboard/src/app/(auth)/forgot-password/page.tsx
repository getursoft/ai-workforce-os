import type { Metadata } from "next";
import { ForgotPasswordForm } from "../../../components/auth/forgot-password-form";

export const metadata: Metadata = {
  title: "Forgot password | Krevia.ai",
  description: "Reset your Krevia.ai password"
};

export default function ForgotPasswordPage() {
  return (
    <main className="auth-screen">
      <ForgotPasswordForm />
    </main>
  );
}

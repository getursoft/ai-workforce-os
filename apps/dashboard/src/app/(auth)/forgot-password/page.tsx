import type { Metadata } from "next";
import { ForgotPasswordForm } from "../../../components/auth/forgot-password-form";

export const metadata: Metadata = {
  title: "Forgot password | AI Workforce OS",
  description: "Reset your AI Workforce OS password"
};

export default function ForgotPasswordPage() {
  return (
    <main className="auth-screen">
      <ForgotPasswordForm />
    </main>
  );
}

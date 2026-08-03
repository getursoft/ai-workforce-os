import type { Metadata } from "next";
import { ResetPasswordForm } from "../../../components/auth/reset-password-form";

export const metadata: Metadata = {
  title: "Reset password | AI Workforce OS",
  description: "Reset your AI Workforce OS password"
};

export default function ResetPasswordPage() {
  return (
    <main className="auth-screen">
      <ResetPasswordForm />
    </main>
  );
}

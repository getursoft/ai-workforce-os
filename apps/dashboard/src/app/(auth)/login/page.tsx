import type { Metadata } from "next";
import { LoginForm } from "../../../components/auth/login-form";

export const metadata: Metadata = {
  title: "Login | AI Workforce OS",
  description: "Sign in to AI Workforce OS"
};

export default function LoginPage() {
  return (
    <main className="auth-screen">
      <LoginForm />
    </main>
  );
}

import type { Metadata } from "next";
import { LoginForm } from "../../../components/auth/login-form";

export const metadata: Metadata = {
  title: "Login | Krevia.ai",
  description: "Sign in to Krevia.ai"
};

export default function LoginPage() {
  return (
    <main className="auth-screen">
      <LoginForm />
    </main>
  );
}

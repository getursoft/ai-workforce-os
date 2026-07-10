import type { Metadata } from "next";
import { SignupForm } from "../../../components/auth/signup-form";

export const metadata: Metadata = {
  title: "Sign up | AI Workforce OS",
  description: "Create your AI Workforce OS workspace"
};

export default function SignupPage() {
  return (
    <main className="auth-screen">
      <SignupForm />
    </main>
  );
}

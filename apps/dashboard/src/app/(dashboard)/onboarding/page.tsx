import type { Metadata } from "next";
import { OnboardingPage } from "../../../features/onboarding/onboarding-page";

export const metadata: Metadata = {
  title: "Getting Started | Krevia.ai"
};

export default function Page() {
  return <OnboardingPage />;
}

import type { Metadata } from "next";
import { ProfilePage } from "../../../components/dashboard/profile-page";

export const metadata: Metadata = {
  title: "Profile | Krevia.ai"
};

export default function ProfileRoute() {
  return <ProfilePage />;
}

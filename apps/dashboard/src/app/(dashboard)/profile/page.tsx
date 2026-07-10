import type { Metadata } from "next";
import { ProfilePage } from "../../../components/dashboard/profile-page";

export const metadata: Metadata = {
  title: "Profile | AI Workforce OS"
};

export default function ProfileRoute() {
  return <ProfilePage />;
}

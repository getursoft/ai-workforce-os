import type { Metadata } from "next";
import { MemoryPage } from "../../../features/memory/memory-pages";

export const metadata: Metadata = {
  title: "Memory | AI Workforce OS"
};

export default function MemoryPageRoute() {
  return <MemoryPage />;
}

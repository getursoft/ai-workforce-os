import type { Metadata } from "next";
import { MemoryPage } from "../../../features/memory/memory-pages";

export const metadata: Metadata = {
  title: "Memory | Krevia.ai"
};

export default function MemoryPageRoute() {
  return <MemoryPage />;
}

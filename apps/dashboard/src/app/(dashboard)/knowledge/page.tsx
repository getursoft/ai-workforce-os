import type { Metadata } from "next";
import { KnowledgePage as KnowledgeBasePage } from "../../../features/knowledge/knowledge-pages";

export const metadata: Metadata = {
  title: "Knowledge | Krevia.ai"
};

export default function KnowledgePage() {
  return <KnowledgeBasePage />;
}

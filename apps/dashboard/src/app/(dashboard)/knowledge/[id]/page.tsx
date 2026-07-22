import { KnowledgeDetailPage } from "../../../../features/knowledge/knowledge-pages";

export default async function KnowledgeDocumentPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <KnowledgeDetailPage id={id} />;
}

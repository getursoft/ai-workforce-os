import { Skeleton } from "../components/ui";

export default function Loading() {
  return (
    <main className="app-screen">
      <Skeleton className="app-screen__loading" />
    </main>
  );
}

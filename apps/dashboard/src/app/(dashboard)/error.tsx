"use client";

import Link from "next/link";
import { Button, EmptyState } from "../../components/ui";

export default function WorkspaceError({ reset }: Readonly<{ reset(): void }>) {
  return (
    <main className="app-screen">
      <EmptyState
        title="Workspace could not be loaded"
        description="An unexpected dashboard error occurred. Reload the workspace or return to login."
        action={
          <>
            <Button type="button" onClick={reset}>
              Reload
            </Button>
            <Link href="/login">Return to login</Link>
          </>
        }
      />
    </main>
  );
}

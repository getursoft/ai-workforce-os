"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button, EmptyState } from "../components/ui";

export default function Error({
  error,
  reset
}: Readonly<{ error: Error & { digest?: string }; reset(): void }>) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="app-screen">
      <EmptyState
        title="Something went wrong"
        description="The application hit an unexpected problem."
        action={
          <>
            <Button type="button" variant="secondary" onClick={reset}>
              Try again
            </Button>
            <Link href="/dashboard">Back to dashboard</Link>
          </>
        }
      />
    </main>
  );
}

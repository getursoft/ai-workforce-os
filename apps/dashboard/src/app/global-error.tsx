"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button, EmptyState } from "../components/ui";

export default function GlobalError({
  error,
  reset
}: Readonly<{ error: Error & { digest?: string }; reset(): void }>) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="app-screen">
          <EmptyState
            title="Application error"
            description="The application failed to render."
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
      </body>
    </html>
  );
}

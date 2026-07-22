"use client";

import Link from "next/link";
import { Component, type ReactNode } from "react";
import { Button, EmptyState } from "../ui";

type Properties = Readonly<{ children: ReactNode }>;
type State = Readonly<{ failed: boolean }>;

export class WorkspaceErrorBoundary extends Component<Properties, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return <WorkspaceErrorFallback />;
  }
}

export function WorkspaceErrorFallback() {
  return (
    <main className="app-screen">
      <EmptyState
        title="Workspace could not be loaded"
        description="An unexpected dashboard error occurred. Reload the page or return to login."
        action={
          <>
            <Button type="button" onClick={() => globalThis.location.reload()}>
              Reload
            </Button>
            <Link href="/login">Return to login</Link>
          </>
        }
      />
    </main>
  );
}

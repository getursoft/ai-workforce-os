export function firstNameOrEmail(firstName: string | null, email: string | undefined): string {
  if (firstName) {
    return firstName;
  }
  return email?.split("@")[0] ?? "there";
}

/** Compact "2m ago" / "3h ago" / "5d ago" style relative time for recent-activity rows — never a fabricated
 *  precision, just the coarsest unit that fits. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffMs = now.getTime() - then;
  if (!Number.isFinite(diffMs) || diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export type ExecutionStatusTone = "success" | "warning" | "danger" | "neutral";

export function toneForExecutionStatus(status: string): ExecutionStatusTone {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED") return "danger";
  if (status === "RUNNING" || status === "QUEUED") return "warning";
  return "neutral";
}

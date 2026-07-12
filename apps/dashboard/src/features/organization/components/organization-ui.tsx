import { Badge, Button, Card, Skeleton } from "../../../components/ui";
import { ApiError } from "../../../lib/api-error";

export function StatusBadge({ status }: Readonly<{ status: string }>) {
  const normalized = status.toUpperCase();
  const tone =
    normalized === "ACTIVE" ? "success" : normalized === "SUSPENDED" ? "danger" : "warning";
  return <Badge tone={tone}>{status}</Badge>;
}

export function LoadingSkeleton() {
  return (
    <div className="organization-loading" aria-label="Loading organization">
      <Skeleton className="organization-loading__card" />
      <Skeleton className="organization-loading__card organization-loading__card--large" />
    </div>
  );
}

export function OrganizationEmptyState({ onRetry }: Readonly<{ onRetry(): void }>) {
  return (
    <Card className="organization-empty">
      <h2>Organization information is unavailable</h2>
      <p>We could not find organization data for this account.</p>
      <Button type="button" onClick={onRetry}>
        Retry
      </Button>
    </Card>
  );
}

export function friendlyOrganizationError(error: unknown): string {
  if (!(error instanceof ApiError)) return "Something unexpected happened. Please try again.";
  if (error.kind === "authentication") return "Your session has expired. Please sign in again.";
  if (error.kind === "authorization")
    return "You do not have permission to manage this organization.";
  if (error.kind === "not_found") return "Organization information could not be found.";
  if (error.kind === "validation") return error.details[0] ?? error.message;
  if (error.kind === "server") return "The service is temporarily unavailable. Please try again.";
  if (error.kind === "network" || error.kind === "timeout")
    return "We could not reach the service. Check your connection and retry.";
  return error.message;
}

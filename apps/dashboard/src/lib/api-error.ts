interface StandardErrorEnvelope {
  error: {
    code: string;
    message: string;
    details: string[];
    requestId: string;
    timestamp: string;
  };
}

export type ApiErrorKind =
  | "validation"
  | "authentication"
  | "authorization"
  | "conflict"
  | "not_found"
  | "rate_limit"
  | "server"
  | "network"
  | "timeout"
  | "unknown";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code: string;
  readonly details: readonly string[];
  readonly requestId?: string;
  readonly timestamp?: string;

  constructor(parameters: {
    kind: ApiErrorKind;
    code: string;
    message: string;
    status?: number | undefined;
    details?: readonly string[] | undefined;
    requestId?: string | undefined;
    timestamp?: string | undefined;
  }) {
    super(parameters.message);
    this.name = "ApiError";
    this.kind = parameters.kind;
    if (parameters.status !== undefined) {
      this.status = parameters.status;
    }
    this.code = parameters.code;
    this.details = parameters.details ?? [];
    if (parameters.requestId !== undefined) {
      this.requestId = parameters.requestId;
    }
    if (parameters.timestamp !== undefined) {
      this.timestamp = parameters.timestamp;
    }
  }
}

export function normalizeApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ApiError({
      kind: "timeout",
      code: "TIMEOUT",
      message: "The request timed out."
    });
  }
  if (error instanceof TypeError) {
    return new ApiError({
      kind: "network",
      code: "NETWORK_ERROR",
      message: "Network unavailable."
    });
  }
  return new ApiError({
    kind: "unknown",
    code: "UNKNOWN_ERROR",
    message: "Unexpected error."
  });
}

export function normalizeServerError(response: Response, body: unknown): ApiError {
  const fallbackMessage = response.status >= 500 ? "Server error." : "Request failed.";
  const envelope = body as Partial<StandardErrorEnvelope> | null;
  const error = envelope?.error;
  const code = typeof error?.code === "string" ? error.code : "UNKNOWN_ERROR";
  const message = typeof error?.message === "string" ? error.message : fallbackMessage;
  const details = Array.isArray(error?.details)
    ? error.details.filter((detail): detail is string => typeof detail === "string")
    : [];
  const requestId = typeof error?.requestId === "string" ? error.requestId : undefined;
  const timestamp = typeof error?.timestamp === "string" ? error.timestamp : undefined;
  return new ApiError({
    kind: mapStatus(response.status),
    code,
    message,
    status: response.status,
    details,
    ...(requestId ? { requestId } : {}),
    ...(timestamp ? { timestamp } : {})
  });
}

function mapStatus(status: number): ApiErrorKind {
  if (status === 400 || status === 422) {
    return "validation";
  }
  if (status === 401) {
    return "authentication";
  }
  if (status === 403) {
    return "authorization";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 409) {
    return "conflict";
  }
  if (status === 429) {
    return "rate_limit";
  }
  if (status >= 500) {
    return "server";
  }
  return "unknown";
}

export class PersistenceConflictError extends Error {
  readonly code = "PERSISTENCE_CONFLICT";

  constructor(readonly constraint: string) {
    super(`A unique persistence constraint was violated: ${constraint}`);
    this.name = "PersistenceConflictError";
  }
}

export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidDomainValueError extends DomainError {
  readonly code = "INVALID_DOMAIN_VALUE";

  constructor(
    readonly field: string,
    message: string
  ) {
    super(message);
  }
}

export class InvalidEntityStateError extends DomainError {
  readonly code = "INVALID_ENTITY_STATE";

  constructor(
    readonly entity: string,
    message: string
  ) {
    super(message);
  }
}

export class InvalidStateTransitionError extends DomainError {
  readonly code = "INVALID_STATE_TRANSITION";

  constructor(
    readonly entity: string,
    message: string
  ) {
    super(message);
  }
}

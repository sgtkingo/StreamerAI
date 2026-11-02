export class ProfileLimitError extends Error {
  readonly code = "PROFILE_LIMIT_REACHED";

  constructor() {
    super("An account can contain at most five profiles.");
    this.name = "ProfileLimitError";
  }
}

export class DatabaseValidationError extends Error {
  readonly code = "DATABASE_VALIDATION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "DatabaseValidationError";
  }
}

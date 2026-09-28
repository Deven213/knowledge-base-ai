/** An integration problem whose message is safe and useful to show the user. */
export class IntegrationError extends Error {
  constructor(
    message: string,
    /** HTTP status to use when this reaches an API response. */
    readonly status = 400,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

/** The OAuth connection is missing, revoked or expired: the user must reconnect. */
export class IntegrationAuthError extends IntegrationError {
  constructor(message: string) {
    super(message, 401);
    this.name = "IntegrationAuthError";
  }
}

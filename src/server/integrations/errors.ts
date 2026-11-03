import type { SyncItemCategory } from "@/lib/integrations";

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

/** A page or file could not be loaded. Carries what went wrong for the sync's run details. */
export class FetchError extends IntegrationError {
  constructor(
    message: string,
    readonly category: SyncItemCategory,
    /** Status of the HTTP response, when the server answered. */
    readonly httpStatus?: number,
    /** Original technical error (already free of secrets). */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

/** The OAuth connection is missing, revoked or expired: the user must reconnect. */
export class IntegrationAuthError extends IntegrationError {
  constructor(message: string) {
    super(message, 401);
    this.name = "IntegrationAuthError";
  }
}

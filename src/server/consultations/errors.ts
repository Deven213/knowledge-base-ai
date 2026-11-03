import "server-only";

/** A refusal with a message that is safe to show the doctor. `code` is stable for the browser and the audit log. */
export class ConsultationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConsultationError";
  }
}

export const notFound = () => new ConsultationError(404, "not_found", "That consultation was not found.");

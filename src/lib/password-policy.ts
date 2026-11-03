// The length rules for a password, in ONE place. The server's validation (server/auth/password.ts) and every form
// that creates or changes a password read these numbers, so the rule can't drift between the browser and the server
// (the server is always the one that decides: a browser check is only a convenience).

/** The shortest password a person may choose, in characters. */
export const PASSWORD_MIN_LENGTH = 4;

/** The longest (a sanity limit, so a request can't make hashing expensive). */
export const PASSWORD_MAX_LENGTH = 200;

// Error contract shared by REST and MCP (PRD 6.3).

export type ErrorCode =
  | "AUTH_REQUIRED"
  | "CONFIRMATION_REQUIRED"
  | "DUPLICATE_CANDIDATE"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_STATE"
  | "INTERNAL";

const HTTP_STATUS: Record<ErrorCode, number> = {
  AUTH_REQUIRED: 401,
  CONFIRMATION_REQUIRED: 428,
  DUPLICATE_CANDIDATE: 409,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE: 409,
  INTERNAL: 500,
};

// What an agent should do next when it sees each code.
const RECOVERY: Record<ErrorCode, string> = {
  AUTH_REQUIRED:
    "Ask the user to connect their GitDex account (OAuth sign-in or a personal API token from /account), then retry.",
  CONFIRMATION_REQUIRED:
    "Show the user the exact public fields in details.preview, ask for explicit approval, then retry with confirmed=true. Do not set confirmed=true on your own.",
  DUPLICATE_CANDIDATE:
    "A matching record already exists (details.candidates). Reuse its ID instead of creating a new record.",
  VALIDATION_FAILED: "Fix the fields listed in details.fields and retry.",
  RATE_LIMITED: "Wait for details.retry_after_seconds before retrying. Do not retry in a loop.",
  FORBIDDEN: "The signed-in user is not allowed to do this. Do not retry; explain the restriction to the user.",
  NOT_FOUND: "Check the ID. Use the search tools to find the correct record.",
  CONFLICT: "The request conflicts with existing state; read the current record and decide with the user.",
  INVALID_STATE: "The record is not in a state that allows this action; read it again and explain to the user.",
  INTERNAL: "Unexpected server error. Retry once with the same idempotency key; if it fails again, tell the user.",
};

export class GitdexError extends Error {
  code: ErrorCode;
  details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "GitdexError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }

  toJSON(): { error: { code: ErrorCode; message: string; recovery: string; details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        recovery: RECOVERY[this.code],
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function toGitdexError(err: unknown): GitdexError {
  if (err instanceof GitdexError) return err;
  return new GitdexError("INTERNAL", "Unexpected server error.");
}

export const ERROR_CODES = Object.keys(HTTP_STATUS) as ErrorCode[];
export const ERROR_HTTP_STATUS = HTTP_STATUS;

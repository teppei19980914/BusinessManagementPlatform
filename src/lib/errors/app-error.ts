/**
 * AppError: code-based domain error class for i18n-aware error handling.
 *
 * Design:
 *   - Service / lib code throws `AppError(code, params)` instead of
 *     `new Error('日本語メッセージ')`. The route / UI layer looks up the human
 *     message via `t('error.' + code, params)`.
 *   - This separates *what happened* (code, machine-readable) from *how to
 *     describe it* (locale-aware translation). The same code can be reused by
 *     UI toasts, API JSON responses, audit logs, and CLI output without string
 *     duplication.
 *
 * HTTP mapping:
 *   - Each code has a default HTTP status (see {@link DEFAULT_STATUS_FOR_CODE}).
 *   - Callers can override per-throw with the `httpStatus` argument when the
 *     spec requires a different status for the same logical code.
 *
 * Adding a code:
 *   1. Extend {@link ErrorCode} union below.
 *   2. Add the default HTTP status in {@link DEFAULT_STATUS_FOR_CODE}.
 *   3. Add `error.<CODE>` translations in `src/i18n/messages/ja.json` and
 *      `src/i18n/messages/en-US.json`.
 *   4. (Optional) Add doc comment near the union entry describing the typical
 *      throwing service and recovery flow.
 *
 * Related:
 *   - docs/i18n/CONVENTIONS.md §5 §7
 *   - src/lib/api-error-handler.ts (route-level catcher)
 */

/**
 * All error codes recognized by the application.
 * **Codes are SCREAMING_SNAKE_CASE and STABLE** — they appear in API responses
 * and audit logs, so renaming is a breaking change.
 *
 * This union grows as services migrate from JP-literal `throw` to AppError.
 */
export type ErrorCode =
  // Generic
  | 'INTERNAL_ERROR'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'TENANT_BOUNDARY_VIOLATION'
  // Tenant
  | 'TENANT_NOT_FOUND'
  | 'TENANT_ALREADY_DELETED'
  | 'TENANT_ALREADY_SUSPENDED'
  | 'TENANT_MANAGEMENT_PROTECTED'
  | 'TENANT_INVALID_REASON'
  | 'TENANT_NAME_MISMATCH'
  // User / Auth
  | 'USER_NOT_FOUND'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_RESET_LINK'
  | 'USED_RESET_LINK'
  | 'EXPIRED_RESET_LINK'
  | 'PASSWORD_REUSE_BLOCKED'
  | 'PASSWORD_INCORRECT'
  | 'MFA_SECRET_MISSING'
  | 'MFA_CODE_INVALID'
  | 'SIGNUP_RATE_LIMITED'
  | 'INVALID_JSON_BODY'
  // Project / Task / Knowledge etc.
  | 'PROJECT_NOT_FOUND'
  | 'TASK_NOT_FOUND'
  | 'KNOWLEDGE_NOT_FOUND'
  | 'RISK_NOT_FOUND'
  | 'RETROSPECTIVE_NOT_FOUND'
  | 'CUSTOMER_NOT_FOUND'
  | 'STAKEHOLDER_NOT_FOUND'
  | 'COMMENT_NOT_FOUND'
  | 'MEMO_NOT_FOUND'
  // Billing / Storage / Plan
  | 'BEGINNER_WRITE_BLOCKED'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'PLAN_DOWNGRADE_OVER_USAGE'
  | 'INVALID_PLAN_VALUE'
  | 'CARD_PAYMENT_DISABLED'
  | 'CARD_ALREADY_CONFIGURED'
  | 'STRIPE_CHECKOUT_FAILED'
  | 'STRIPE_PORTAL_FAILED'
  | 'PAYMENT_METHOD_CHANGE_FAILED'
  // Import / Export / Sync
  | 'IMPORT_IN_PROGRESS'
  | 'IMPORT_FILE_EMPTY'
  | 'IMPORT_FILE_TOO_LARGE'
  | 'IMPORT_FILE_UNREADABLE'
  | 'IMPORT_ZIP_STRUCTURE_INVALID'
  | 'IMPORT_ZIP_TOO_LARGE'
  | 'CSV_HEADER_MISSING'
  | 'CSV_PARSE_FAILED'
  // Embedding / LLM
  | 'EMBEDDING_EMPTY_INPUT'
  | 'EMBEDDING_GENERATION_FAILED'
  | 'EMBEDDING_DIMENSION_MISMATCH'
  // Mail
  | 'MAIL_PROVIDER_NOT_CONFIGURED'
  | 'MAIL_SEND_FAILED'
  | 'MAIL_DAILY_LIMIT_REACHED'
  // Permission (state-based)
  | 'PERMISSION_STATE_FORBIDDEN'
  | 'PERMISSION_ROLE_FORBIDDEN'
  | 'PERMISSION_OWNER_ONLY_KNOWLEDGE'
  | 'PERMISSION_ASSIGNEE_ONLY_TASK'
  | 'PERMISSION_REPORTER_OR_ASSIGNEE_ONLY_RISK'
  | 'PERMISSION_AUTHOR_ONLY_COMMENT';

export type AppErrorParams = Record<string, string | number | boolean | null | undefined>;

/**
 * Default HTTP status per ErrorCode. Each new code MUST be added here; the
 * exhaustiveness check below catches forgotten entries at compile time.
 */
const DEFAULT_STATUS_FOR_CODE: Record<ErrorCode, number> = {
  // 4xx — client
  INVALID_CREDENTIALS: 401,
  UNAUTHORIZED: 401,
  PASSWORD_INCORRECT: 401,
  MFA_CODE_INVALID: 401,

  FORBIDDEN: 403,
  TENANT_BOUNDARY_VIOLATION: 403,
  TENANT_MANAGEMENT_PROTECTED: 403,
  BEGINNER_WRITE_BLOCKED: 403,
  PERMISSION_STATE_FORBIDDEN: 403,
  PERMISSION_ROLE_FORBIDDEN: 403,
  PERMISSION_OWNER_ONLY_KNOWLEDGE: 403,
  PERMISSION_ASSIGNEE_ONLY_TASK: 403,
  PERMISSION_REPORTER_OR_ASSIGNEE_ONLY_RISK: 403,
  PERMISSION_AUTHOR_ONLY_COMMENT: 403,

  NOT_FOUND: 404,
  TENANT_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  KNOWLEDGE_NOT_FOUND: 404,
  RISK_NOT_FOUND: 404,
  RETROSPECTIVE_NOT_FOUND: 404,
  CUSTOMER_NOT_FOUND: 404,
  STAKEHOLDER_NOT_FOUND: 404,
  COMMENT_NOT_FOUND: 404,
  MEMO_NOT_FOUND: 404,
  INVALID_RESET_LINK: 404,
  MFA_SECRET_MISSING: 404,

  VALIDATION_ERROR: 400,
  INVALID_JSON_BODY: 400,
  INVALID_PLAN_VALUE: 400,
  TENANT_INVALID_REASON: 400,
  TENANT_NAME_MISMATCH: 400,
  IMPORT_FILE_EMPTY: 400,
  IMPORT_FILE_TOO_LARGE: 413,
  IMPORT_FILE_UNREADABLE: 400,
  IMPORT_ZIP_STRUCTURE_INVALID: 400,
  IMPORT_ZIP_TOO_LARGE: 413,
  CSV_HEADER_MISSING: 400,
  CSV_PARSE_FAILED: 400,
  EMBEDDING_EMPTY_INPUT: 400,
  EMBEDDING_DIMENSION_MISMATCH: 500, // server-side anomaly, not user fault

  CONFLICT: 409,
  TENANT_ALREADY_DELETED: 409,
  TENANT_ALREADY_SUSPENDED: 409,
  USED_RESET_LINK: 409,
  PASSWORD_REUSE_BLOCKED: 409,
  IMPORT_IN_PROGRESS: 409,
  CARD_ALREADY_CONFIGURED: 409,
  PLAN_DOWNGRADE_OVER_USAGE: 409,
  STORAGE_QUOTA_EXCEEDED: 409,
  CARD_PAYMENT_DISABLED: 409,

  EXPIRED_RESET_LINK: 410,
  RATE_LIMITED: 429,
  SIGNUP_RATE_LIMITED: 429,
  MAIL_DAILY_LIMIT_REACHED: 429,

  // 5xx — server
  INTERNAL_ERROR: 500,
  EMBEDDING_GENERATION_FAILED: 500,
  MAIL_PROVIDER_NOT_CONFIGURED: 500,
  MAIL_SEND_FAILED: 502,
  STRIPE_CHECKOUT_FAILED: 502,
  STRIPE_PORTAL_FAILED: 502,
  PAYMENT_METHOD_CHANGE_FAILED: 502,
};

/**
 * Domain error.
 *
 * @example
 *   throw new AppError('TENANT_NOT_FOUND', { tenantId: id });
 *   throw new AppError('VALIDATION_ERROR', { field: 'name', reason: 'tooLong' }, 400);
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly params: AppErrorParams;
  readonly httpStatus: number;

  constructor(code: ErrorCode, params: AppErrorParams = {}, httpStatus?: number) {
    // The Error.message is dev-facing only. UI text comes from the i18n catalog
    // via the code. Keeping a non-empty message helps `console.error(err)` in
    // local dev and avoids accidental empty stack frames.
    super(`AppError(${code})`);
    this.name = 'AppError';
    this.code = code;
    this.params = params;
    this.httpStatus = httpStatus ?? DEFAULT_STATUS_FOR_CODE[code];
  }

  /**
   * Serializable representation safe for API JSON responses.
   * Excludes stack / dev-facing message — the locale-aware human text is added
   * by `handleApiError` after translation.
   */
  toJSON(): { code: ErrorCode; params: AppErrorParams } {
    return { code: this.code, params: this.params };
  }
}

/**
 * Type guard.
 */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Build the i18n catalog key for an AppError code.
 * Centralizing here ensures `t(errorCatalogKey(err.code), err.params)` is the
 * only valid pattern (no `t('error.' + code)` string concat scattered).
 */
export function errorCatalogKey(code: ErrorCode): `error.${ErrorCode}` {
  return `error.${code}` as const;
}

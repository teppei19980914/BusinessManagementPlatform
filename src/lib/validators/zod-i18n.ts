/**
 * zod ⇄ i18n integration.
 *
 * Translates Zod validation issues into locale-aware messages via the
 * `validation.*` namespace in the message catalog.
 *
 * Usage (preferred):
 *   const data = await parseOrThrowAppError(schema, requestBody);
 *   // → throws AppError('VALIDATION_ERROR', { issues: [...] }) on failure
 *   // → route handler's withErrorHandler picks it up and translates
 *
 * Direct translation:
 *   const issues = await translateZodIssues(err); // for fine-grained UI display
 *
 * Related:
 *   - docs/i18n/CONVENTIONS.md §4 §5
 *   - src/lib/errors/app-error.ts (VALIDATION_ERROR code)
 */

import { z } from 'zod';
import { getTranslations } from 'next-intl/server';
import { AppError } from '@/lib/errors/app-error';

export interface TranslatedIssue {
  /** Dotted path to the offending field, e.g. "name" or "items.0.title". Empty string for top-level. */
  path: string;
  /** Catalog key actually used (`validation.<key>`). Useful for debugging / log analytics. */
  catalogKey: string;
  /** Localized human-readable message. */
  message: string;
}

/**
 * Map a Zod issue to a `validation.*` key.
 * Granular enough that the UI can display contextual messages
 * (e.g. "{min} characters or more" vs "must be a number").
 */
function pickCatalogKey(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return 'invalidType';
    case 'invalid_value':
      return 'invalidValue';
    case 'too_small':
      return 'tooSmall';
    case 'too_big':
      return 'tooBig';
    case 'invalid_format':
      return 'invalidFormat';
    case 'unrecognized_keys':
      return 'unrecognizedKeys';
    case 'invalid_union':
      return 'invalidUnion';
    case 'not_multiple_of':
      return 'notMultipleOf';
    case 'custom':
    default:
      return 'custom';
  }
}

/**
 * Extract ICU placeholder params from a Zod issue.
 * Keys here MUST match the placeholder names used in `messages/*.json`
 * `validation.<key>` values. See docs/i18n/CONVENTIONS.md §4.
 */
function extractParams(issue: z.core.$ZodIssue): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  if (issue.path.length > 0) params.path = issue.path.join('.');

  // `too_small` / `too_big` carry `minimum` / `maximum` and `inclusive`.
  const anyIssue = issue as unknown as Record<string, unknown>;
  if (typeof anyIssue.minimum === 'number') params.min = anyIssue.minimum;
  if (typeof anyIssue.maximum === 'number') params.max = anyIssue.maximum;
  if (typeof anyIssue.expected === 'string') params.expected = anyIssue.expected;
  if (typeof anyIssue.received === 'string') params.received = anyIssue.received;
  if (typeof anyIssue.format === 'string') params.format = anyIssue.format;

  return params;
}

/** Translate a list of Zod issues into localized issues. Never throws. */
export async function translateZodIssues(
  err: z.ZodError,
): Promise<TranslatedIssue[]> {
  let t: (key: string, params?: Record<string, string | number>) => string;
  try {
    t = await getTranslations('validation');
  } catch {
    // Translation context unavailable (e.g. cron / test). Fall back to keys.
    t = (k) => `validation.${k}`;
  }

  return err.issues.map((issue) => {
    const catalogKey = pickCatalogKey(issue);
    const params = extractParams(issue);
    let message: string;
    try {
      message = t(catalogKey, params);
    } catch {
      message = issue.message; // catalog miss; use zod's default English
    }
    return {
      path: issue.path.map(String).join('.'),
      catalogKey: `validation.${catalogKey}`,
      message,
    };
  });
}

/**
 * Run a zod schema against input. On failure, throw a single
 * `AppError('VALIDATION_ERROR', { issues })` so `withErrorHandler` can serialize it.
 *
 * The thrown AppError's `params.issues` is a JSON-safe array; route handlers /
 * UI can iterate to attach per-field error highlights.
 */
export async function parseOrThrowAppError<T>(
  schema: z.ZodType<T>,
  input: unknown,
): Promise<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = await translateZodIssues(result.error);
  throw new AppError(
    'VALIDATION_ERROR',
    // AppErrorParams is Record<string, string|number|...>. Encode the issues
    // list as JSON to keep typing simple; the handler / UI parses back.
    { issuesJson: JSON.stringify(issues) },
    400,
  );
}

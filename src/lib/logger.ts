/**
 * Operator-facing structured logger for scripts, crons, and CLI tools.
 *
 * Audience:
 *   Operators / oncall engineers reading log output in CI, terminals, or
 *   cron monitor dashboards. **NOT end users** — end-user-visible messages
 *   belong in the i18n catalog and go through `t()`.
 *
 * Why English-only:
 *   - Operations / SRE convention is English (matches the Anthropic / Sentry /
 *     PagerDuty / Datadog ecosystem).
 *   - Avoids the noisy JP literals that previously littered `console.log`
 *     calls and tripped the hardcoded-JP regression gate.
 *   - Removes locale ambiguity from log analytics.
 *
 * Why not `console.*`:
 *   - `eslint.config.mjs` bans `console.*` inside `src/**` (PR #115) to prevent
 *     ad-hoc debug output from shipping. This wrapper provides the one
 *     allowed exit through `process.stdout` / `process.stderr`.
 *   - Structured (JSON) output is greppable / dashboardable without parsing
 *     free-form prefixes.
 *
 * Output format:
 *   One JSON object per line:
 *     {"ts":"2026-06-12T05:23:01.123Z","level":"info","event":"tenant.suspend.completed","tenantId":"...","reason":"overdue"}
 *
 * Usage:
 *   import { opLog } from '@/lib/logger';
 *   opLog.info('tenant.suspend.completed', { tenantId, reason: 'overdue' });
 *   opLog.warn('cron.skip', { reason: 'feature_flag_off' });
 *   opLog.error('mail.send.failed', { provider: 'brevo', status: 502 });
 *
 * Related:
 *   - docs/i18n/CONVENTIONS.md §1 (locale resolution, end-user vs operator)
 *   - src/services/error-log.service.ts (DB-side error log for production
 *     incidents — different concern, that one persists to `system_error_logs`)
 */

type LogLevel = 'info' | 'warn' | 'error';

/** Allowed payload value types (JSON-safe primitives + nested objects). */
type Scalar = string | number | boolean | null;
type Payload = { [key: string]: Scalar | Scalar[] | Payload | Payload[] };

interface LogEntry extends Payload {
  ts: string;
  level: LogLevel;
  event: string;
}

/**
 * Module-level injection point for tests. Production code paths never touch this.
 * Setting these to vi-mocked functions lets unit tests capture log output without
 * polluting stdout. Reset to `null` to restore the default process.* sinks.
 */
let __testStdout: ((line: string) => void) | null = null;
let __testStderr: ((line: string) => void) | null = null;

/** @internal — test-only sink override. */
export function __setTestSinks(opts: {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}): void {
  __testStdout = opts.stdout ?? null;
  __testStderr = opts.stderr ?? null;
}

function emit(entry: LogEntry): void {
  const line = JSON.stringify(entry) + '\n';
  if (entry.level === 'info') {
    if (__testStdout) __testStdout(line);
    else process.stdout.write(line);
  } else {
    if (__testStderr) __testStderr(line);
    else process.stderr.write(line);
  }
}

/**
 * Build an entry. `ts` is always now() — passing a fixed timestamp would defeat
 * sort-by-time triage in dashboards. Tests assert on level/event/other fields.
 */
function logAt(level: LogLevel, event: string, fields?: Payload): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(fields ?? {}),
  };
  emit(entry);
}

/**
 * Operator log API. Lowercase singleton object for terse calls at sites.
 *
 * Event names are dotted lowercase (e.g. `tenant.suspend.completed`). They are
 * stable identifiers — renaming a frequently-used event breaks existing
 * dashboards / alerts, so prefer adding a new event over renaming.
 */
export const opLog = {
  info(event: string, fields?: Payload): void {
    logAt('info', event, fields);
  },
  warn(event: string, fields?: Payload): void {
    logAt('warn', event, fields);
  },
  error(event: string, fields?: Payload): void {
    logAt('error', event, fields);
  },
};

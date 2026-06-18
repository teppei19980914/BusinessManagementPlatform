/**
 * Semantic i18n anti-pattern gate.
 *
 * Detects two classes of banned patterns where Japanese literals bypass the i18n catalog:
 *
 * Pattern A — `throw new Error('<JP literal>')` in src/app/api/**, src/lib/**, src/services/**
 *   These paths must throw AppError instead (src/lib/errors/app-error.ts).
 *   src/app/api and src/lib currently have 0 violations → effectively zero-tolerance.
 *   src/services has known violations (see baseline) → baseline-tolerance until P4 is done.
 *
 * Pattern B — legacy `showError('<JP literal>')` / `showSuccess('<JP literal>')`
 *   The correct variants are showErrorKey() / showSuccessKey() which use catalog keys.
 *   Direct JP string arguments bypass the catalog. Known violations are in the baseline.
 *
 * Operating modes (same interface as check-no-hardcoded-jp.ts):
 *   --report                  Print per-file counts, exit 0.
 *   --baseline <file>         Compare per-file counts to baseline; fail on regression.
 *   --update-baseline <file>  Rewrite baseline with current counts.
 *   --strict                  Fail on ANY violation. Enable once all baseline files reach 0.
 *
 * Scan scope: src/** (same exclusions as check-no-hardcoded-jp.ts)
 *
 * Related: docs/i18n/HANDOFF_PHASE2.md §P9, docs/knowledge/KDD_PATTERNS.md §ハードコード復活防止
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');

const SCAN_ROOTS = [join('src')];
const EXCLUDED_DIRS = new Set(['node_modules', '.next', 'generated', '__mocks__']);

const JP_CHAR = /[ぁ-ゖァ-ヺ一-鿿]/;

/** throw new Error( on a line that also contains JP — should be AppError instead. */
const THROW_NEW_ERROR_RE = /\bthrow\s+new\s+Error\s*\(/;

/**
 * show(Error|Success)( without the Key suffix — direct JP string argument bypasses catalog.
 * Negative lookahead (?!Key) excludes the correct showErrorKey / showSuccessKey variants.
 */
const LEGACY_TOAST_RE = /\bshow(?:Error|Success)(?!Key)\s*\(/;

interface PatternCounts {
  throwError: number;
  legacyToast: number;
}

interface CliArgs {
  mode: 'report' | 'baseline-check' | 'update-baseline' | 'strict';
  baselineFile?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mode: 'report' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--report') args.mode = 'report';
    else if (a === '--strict') args.mode = 'strict';
    else if (a === '--baseline') {
      args.mode = 'baseline-check';
      args.baselineFile = argv[++i];
    } else if (a === '--update-baseline') {
      args.mode = 'update-baseline';
      args.baselineFile = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if ((args.mode === 'baseline-check' || args.mode === 'update-baseline') && !args.baselineFile) {
    throw new Error(`${args.mode} requires a baseline file path`);
  }
  return args;
}

/** Strip // and block comments so JP in comments is not counted. */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let inStr: string | null = null;
  let inTpl = false;
  let inBlock = false;
  let inLine = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      i++;
      continue;
    }
    if (inStr) {
      if (c === '\\') {
        out += c + (src[i + 1] || '');
        i += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      out += c;
      i++;
      continue;
    }
    if (inTpl) {
      if (c === '\\') {
        out += c + (src[i + 1] || '');
        i += 2;
        continue;
      }
      if (c === '`') inTpl = false;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      inStr = c;
      out += c;
      i++;
      continue;
    }
    if (c === '`') {
      inTpl = true;
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Count banned patterns in already-comment-stripped source.
 * Exported for unit testing.
 */
export function countBannedPatterns(strippedSource: string): PatternCounts {
  const lines = strippedSource.split('\n');
  let throwError = 0;
  let legacyToast = 0;
  for (const line of lines) {
    if (!JP_CHAR.test(line)) continue;
    if (THROW_NEW_ERROR_RE.test(line)) throwError++;
    if (LEGACY_TOAST_RE.test(line)) legacyToast++;
  }
  return { throwError, legacyToast };
}

function isScannable(relPath: string): boolean {
  const norm = relPath.split(sep).join('/');
  if (!/\.(tsx?|jsx?)$/.test(norm)) return false;
  if (/\.(test|spec|stories)\./.test(norm)) return false;
  if (norm.startsWith('src/i18n/messages/')) return false;
  if (norm.startsWith('src/i18n/messages.test.ts')) return false;
  if (norm.startsWith('src/generated/')) return false;
  return true;
}

function walk(target: string, out: string[]): void {
  const abs = join(REPO_ROOT, target);
  if (!existsSync(abs)) return;
  const st = statSync(abs);
  if (st.isFile()) {
    if (isScannable(target)) out.push(target);
    return;
  }
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walk(join(target, entry.name), out);
    } else if (entry.isFile()) {
      const rel = join(target, entry.name);
      if (isScannable(rel)) out.push(rel);
    }
  }
}

function scanFile(relPath: string): PatternCounts {
  const abs = join(REPO_ROOT, relPath);
  const src = readFileSync(abs, 'utf8');
  return countBannedPatterns(stripComments(src));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const files: string[] = [];
  for (const target of SCAN_ROOTS) walk(target, files);

  const counts: Record<string, PatternCounts> = {};
  let totalThrowError = 0;
  let totalLegacyToast = 0;

  for (const f of files) {
    const result = scanFile(f);
    if (result.throwError > 0 || result.legacyToast > 0) {
      const key = f.split(sep).join('/');
      counts[key] = result;
      totalThrowError += result.throwError;
      totalLegacyToast += result.legacyToast;
    }
  }

  const totalViolations = totalThrowError + totalLegacyToast;
  const totalFiles = Object.keys(counts).length;

  if (args.mode === 'report') {
    console.log(`[i18n-banned] scanned ${files.length} files`);
    console.log(
      `[i18n-banned] violations: throwError=${totalThrowError} legacyToast=${totalLegacyToast} (${totalFiles} files)`,
    );
    const sorted = Object.entries(counts).sort(
      ([, a], [, b]) => b.throwError + b.legacyToast - (a.throwError + a.legacyToast),
    );
    for (const [f, c] of sorted) {
      console.log(`  throwError=${c.throwError} legacyToast=${c.legacyToast}  ${f}`);
    }
    process.exit(0);
  }

  if (args.mode === 'update-baseline') {
    const sortedCounts = Object.fromEntries(
      Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
    );
    writeFileSync(
      join(REPO_ROOT, args.baselineFile!),
      JSON.stringify(
        {
          $schema: 'i18n-banned-patterns/v1',
          $description:
            'Per-file banned i18n pattern counts. Update only when intentional progress is made (P4/Phase 2 migration).',
          generatedAt: new Date(0).toISOString().slice(0, 10),
          totalThrowError,
          totalLegacyToast,
          files: sortedCounts,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`[i18n-banned] baseline written to ${args.baselineFile}`);
    console.log(
      `[i18n-banned] ${totalFiles} files / throwError=${totalThrowError} legacyToast=${totalLegacyToast} locked in`,
    );
    process.exit(0);
  }

  if (args.mode === 'strict') {
    if (totalViolations === 0) {
      console.log('[i18n-banned] strict OK — no banned patterns found');
      process.exit(0);
    }
    console.error(
      `[i18n-banned] strict FAIL — throwError=${totalThrowError} legacyToast=${totalLegacyToast} in ${totalFiles} files`,
    );
    for (const [f, c] of Object.entries(counts)) {
      console.error(`  throwError=${c.throwError} legacyToast=${c.legacyToast}  ${f}`);
    }
    process.exit(1);
  }

  // baseline-check
  const baselinePath = join(REPO_ROOT, args.baselineFile!);
  if (!existsSync(baselinePath)) {
    console.error(`[i18n-banned] baseline file not found: ${args.baselineFile}`);
    console.error('  Run with --update-baseline first.');
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
    files: Record<string, PatternCounts>;
  };
  const baselineFiles = baseline.files || {};

  const regressions: Array<{
    file: string;
    was: PatternCounts;
    now: PatternCounts;
  }> = [];

  for (const [file, now] of Object.entries(counts)) {
    const was = baselineFiles[file] ?? { throwError: 0, legacyToast: 0 };
    if (now.throwError > was.throwError || now.legacyToast > was.legacyToast) {
      regressions.push({ file, was, now });
    }
  }

  const baselineTotals = Object.values(baselineFiles).reduce(
    (s, c) => ({ throwError: s.throwError + c.throwError, legacyToast: s.legacyToast + c.legacyToast }),
    { throwError: 0, legacyToast: 0 },
  );

  if (regressions.length === 0) {
    console.log(
      `[i18n-banned] baseline OK — throwError=${totalThrowError} (baseline ${baselineTotals.throwError}) legacyToast=${totalLegacyToast} (baseline ${baselineTotals.legacyToast})`,
    );
    process.exit(0);
  }

  console.error(`[i18n-banned] regression FAIL — ${regressions.length} files exceeded baseline`);
  for (const r of regressions) {
    const deltaThrow = r.now.throwError - r.was.throwError;
    const deltaToast = r.now.legacyToast - r.was.legacyToast;
    console.error(
      `  ${r.file}: throwError ${r.was.throwError}->${r.now.throwError} (${deltaThrow > 0 ? '+' : ''}${deltaThrow})  legacyToast ${r.was.legacyToast}->${r.now.legacyToast} (${deltaToast > 0 ? '+' : ''}${deltaToast})`,
    );
  }
  console.error('');
  console.error('  Fix the regression or, if this is intentional (migration in progress),');
  console.error(
    `  run: pnpm tsx scripts/check-banned-i18n-patterns.ts --update-baseline ${args.baselineFile}`,
  );
  process.exit(1);
}

if (require.main === module) {
  main();
}

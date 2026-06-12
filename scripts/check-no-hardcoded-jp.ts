/**
 * Hardcoded JP regression gate.
 *
 * Detects Japanese characters in string literals / template literals / JSX text nodes
 * inside source code that **should** flow through the i18n catalog
 * (src/i18n/messages/*.json).
 *
 * Operating modes:
 *   --report                       Print per-file counts, exit 0 (default).
 *   --baseline <file>              Compare per-file counts to baseline; fail if any
 *                                  file's count grew or a new file with JP appeared.
 *                                  After all i18n refactor is done and baseline reaches 0
 *                                  everywhere, this effectively becomes --strict.
 *   --update-baseline <file>       Rewrite baseline with current counts (run after
 *                                  intentional chunk progress to lock in the new floor).
 *   --strict                       Fail on ANY hardcoded JP outside the catalog. Switch
 *                                  to this once P10 final scan passes.
 *
 * Scope:
 *   - src/** (excluding messages/, generated/, *.test.ts, *.spec.ts, *.stories.{ts,tsx})
 *   - prisma/seed.ts / prisma/seed-suggestion.ts
 *
 * What counts as "hardcoded JP":
 *   - Hiragana (U+3041..U+3096) / Katakana (U+30A1..U+30FA) / CJK (U+4E00..U+9FFF)
 *     appearing inside:
 *       - single- or double-quoted string literals
 *       - template literals (`...`)
 *       - JSX text nodes between `>...</`
 *   - Comments (// and / * * /) are stripped before detection (matches the spirit:
 *     "user-visible strings" only).
 *
 * Whitelist:
 *   - src/i18n/messages/**.json — catalog itself
 *   - src/i18n/messages.test.ts — verifies catalog content
 *   - docs/i18n/GLOSSARY.md — glossary lookup
 *
 * Related: docs/i18n/CONVENTIONS.md §3 §10 (PR review checklist)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');

const SCAN_ROOTS = [join('src'), join('prisma', 'seed.ts'), join('prisma', 'seed-suggestion.ts')];

const EXCLUDED_DIRS = new Set(['node_modules', '.next', 'generated']);

const JP_CHAR = /[ぁ-ゖァ-ヺ一-鿿]/;

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

function isScannable(relPath: string): boolean {
  const norm = relPath.split(sep).join('/');
  if (!/\.(tsx?|jsx?)$/.test(norm)) return false;
  if (/\.(test|spec|stories)\./.test(norm)) return false;
  if (norm.startsWith('src/i18n/messages/')) return false;
  if (norm.startsWith('src/i18n/messages.test.ts')) return false;
  if (norm.startsWith('src/generated/')) return false;
  return true;
}

/** Strip // and /* * / comments out of TS/TSX source so JP in comments is ignored. */
function stripComments(src: string): string {
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

interface Hit {
  file: string;
  line: number;
  snippet: string;
}

function scanFile(relPath: string): Hit[] {
  const abs = join(REPO_ROOT, relPath);
  const src = readFileSync(abs, 'utf8');
  const stripped = stripComments(src);
  const hits: Hit[] = [];
  const lines = stripped.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (JP_CHAR.test(lines[i])) {
      hits.push({
        file: relPath.split(sep).join('/'),
        line: i + 1,
        snippet: lines[i].trim().slice(0, 200),
      });
    }
  }
  return hits;
}

function countsByFile(hits: Hit[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const h of hits) counts[h.file] = (counts[h.file] || 0) + 1;
  return counts;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const files: string[] = [];
  for (const target of SCAN_ROOTS) walk(target, files);

  const allHits: Hit[] = [];
  for (const f of files) {
    const hits = scanFile(f);
    allHits.push(...hits);
  }

  const counts = countsByFile(allHits);
  const totalLines = allHits.length;
  const totalFiles = Object.keys(counts).length;

  if (args.mode === 'report') {
    console.log(`[i18n-check] scanned ${files.length} files`);
    console.log(`[i18n-check] hardcoded JP found in ${totalFiles} files, ${totalLines} lines`);
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    for (const [f, n] of sorted) console.log(`  ${String(n).padStart(5)}  ${f}`);
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
          $schema: 'i18n-baseline/v1',
          $description:
            'Per-file hardcoded JP line counts. Update only when intentional progress is made.',
          generatedAt: new Date(0).toISOString().slice(0, 10),
          totalFiles,
          totalLines,
          files: sortedCounts,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`[i18n-check] baseline written to ${args.baselineFile}`);
    console.log(`[i18n-check] ${totalFiles} files / ${totalLines} lines locked in`);
    process.exit(0);
  }

  if (args.mode === 'strict') {
    if (totalLines === 0) {
      console.log('[i18n-check] strict OK — no hardcoded JP found');
      process.exit(0);
    }
    console.error(`[i18n-check] strict FAIL — ${totalLines} hardcoded JP lines in ${totalFiles} files`);
    for (const h of allHits.slice(0, 50)) {
      console.error(`  ${h.file}:${h.line}  ${h.snippet}`);
    }
    if (allHits.length > 50) console.error(`  ... and ${allHits.length - 50} more`);
    process.exit(1);
  }

  // baseline-check
  const baselinePath = join(REPO_ROOT, args.baselineFile!);
  if (!existsSync(baselinePath)) {
    console.error(`[i18n-check] baseline file not found: ${args.baselineFile}`);
    console.error('  Run with --update-baseline first.');
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
    files: Record<string, number>;
  };
  const baselineFiles = baseline.files || {};

  const regressions: Array<{ file: string; was: number; now: number }> = [];
  for (const [file, now] of Object.entries(counts)) {
    const was = baselineFiles[file] ?? 0;
    if (now > was) regressions.push({ file, was, now });
  }

  if (regressions.length === 0) {
    console.log(
      `[i18n-check] baseline OK — ${totalLines} JP lines (baseline ${baseline.files ? Object.values(baselineFiles).reduce((s, n) => s + n, 0) : '?'})`,
    );
    process.exit(0);
  }

  console.error(`[i18n-check] regression FAIL — ${regressions.length} files exceeded baseline`);
  for (const r of regressions) {
    console.error(`  ${r.file}: ${r.was} -> ${r.now} (+${r.now - r.was})`);
  }
  console.error('');
  console.error('  If this regression is intentional (catalog migration in progress),');
  console.error(`  run: pnpm tsx scripts/check-no-hardcoded-jp.ts --update-baseline ${args.baselineFile}`);
  process.exit(1);
}

main();

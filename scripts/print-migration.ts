/**
 * 指定したマイグレーション名の migration.sql をそのまま stdout に出力する。
 * Supabase SQL Editor への貼り付け用途 (PR #66: パス貼り付け事故の再発防止)。
 *
 * 使い方:
 *   pnpm migrate:print 20260419_project_process_tags_and_suggestion
 *   pnpm migrate:print  (引数なしで未適用候補を一覧表示)
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MIGRATIONS_DIR = resolve(process.cwd(), 'prisma', 'migrations');

function listMigrations(): string[] {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(`migrations directory not found: ${MIGRATIONS_DIR}`);
  }
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function printMigration(name: string): void {
  const dir = join(MIGRATIONS_DIR, name);
  const file = join(dir, 'migration.sql');
  if (!existsSync(file)) {
    console.error(`migration.sql が見つかりません: ${file}`);
    console.error('');
    console.error('利用可能なマイグレーション:');
    for (const m of listMigrations()) console.error(`  - ${m}`);
    process.exit(1);
  }
  // そのまま stdout に流す。リダイレクトでクリップボードにも渡せる:
  //   pnpm migrate:print <name> | clip            (Windows)
  //   pnpm migrate:print <name> | pbcopy          (macOS)
  //   pnpm migrate:print <name> | xclip -sel clip (Linux)
  process.stdout.write(readFileSync(file, 'utf8'));
}

const arg = process.argv[2];
if (!arg) {
  console.error('利用可能なマイグレーション (新しい順):');
  for (const m of listMigrations().reverse()) console.error(`  - ${m}`);
  console.error('');
  console.error('使い方: pnpm migrate:print <name>');
  process.exit(1);
}
printMigration(arg);

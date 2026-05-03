/**
 * scripts/recover-prisma-migrations.ts
 *
 * Prisma migration drift リカバリスクリプト (PR fix/missing-migrations / 2026-05-03)
 *
 * 用途:
 *   過去に Supabase SQL Editor 等で手動適用された migration が `_prisma_migrations`
 *   テーブルに記録されておらず、`prisma migrate deploy` 実行時に
 *   `Error: P3018 column ... already exists` で失敗する状況のリカバリ。
 *
 * 動作:
 *   `prisma/migrations/` 配下の全 migration ディレクトリ名を列挙し、
 *   コマンドライン引数で「最後に確実に適用されている migration の名前」(--upto) を
 *   指定すると、それまでの全 migration に対して `prisma migrate resolve --applied <name>`
 *   を実行する。これにより `_prisma_migrations` に記録が追加され、以降の
 *   `prisma migrate deploy` がそれら以前の migration を「適用済み」と認識する。
 *
 * 使い方:
 *   ```bash
 *   # .env.local に本番 DIRECT_URL を一時設定 (Session Pooler、port 5432)
 *
 *   # ① 「20260501_notifications までは確実に適用済」と分かっている場合:
 *   pnpm tsx scripts/recover-prisma-migrations.ts --upto 20260501_notifications
 *
 *   # ② リカバリ後に通常の deploy:
 *   pnpm db:deploy
 *   ```
 *
 *   `--upto` 指定の migration までを resolve し、それ以降は触らない。
 *   その後 `db:deploy` で未適用の migration (例: 20260502_multi_tenant_base 以降) のみ
 *   実際に DB に適用される。
 *
 * 安全性:
 *   - `prisma migrate resolve --applied` は DB のスキーマには触らず、`_prisma_migrations`
 *     テーブルに記録を追加するだけ。万一 `--upto` を間違えても schema は壊れない。
 *   - 既に resolve 済の migration に対する `--applied` は冪等 (no-op or 警告のみ)。
 *
 * 想定外の状況:
 *   - 指定された `--upto` が prisma/migrations/ に存在しない → exit 1
 *   - resolve コマンドが失敗 → エラー出力後、処理続行 (他の migration は試す)
 */

import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const uptoIdx = args.indexOf('--upto');
if (uptoIdx === -1 || !args[uptoIdx + 1]) {
  console.error('Usage: pnpm tsx scripts/recover-prisma-migrations.ts --upto <migration-name>');
  console.error('');
  console.error('例:');
  console.error('  pnpm tsx scripts/recover-prisma-migrations.ts --upto 20260501_notifications');
  console.error('');
  console.error('  → 20260501_notifications までの全 migration を「適用済」として _prisma_migrations に記録');
  console.error('  → その後 pnpm db:deploy で 20260502_* (未適用分) のみ実際に適用される');
  process.exit(1);
}
const upto = args[uptoIdx + 1];

const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
const allMigrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (!allMigrations.includes(upto)) {
  console.error(`❌ Migration '${upto}' が prisma/migrations/ に存在しません`);
  console.error('');
  console.error('利用可能な migration:');
  for (const m of allMigrations) console.error(`  - ${m}`);
  process.exit(1);
}

const uptoIndex = allMigrations.indexOf(upto);
const targets = allMigrations.slice(0, uptoIndex + 1);

console.log(`🔍 対象 migration: ${targets.length} 件 (先頭から ${upto} まで)`);
console.log('');

let succeeded = 0;
let failed = 0;
for (const m of targets) {
  process.stdout.write(`  Resolving: ${m} ... `);
  try {
    execSync(`pnpm prisma migrate resolve --applied "${m}"`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log('✅');
    succeeded++;
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? '';
    if (stderr.includes('already recorded') || stderr.includes('was applied')) {
      console.log('🔄 (既に記録済)');
      succeeded++;
    } else {
      console.log('❌');
      console.error(`     ${stderr.split('\n').slice(0, 3).join(' | ')}`);
      failed++;
    }
  }
}

console.log('');
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  成功: ${succeeded} / ${targets.length}`);
console.log(`  失敗: ${failed}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log('');
console.log('次のアクション: pnpm db:deploy');
console.log(`  → ${upto} 以降の未適用 migration (例: 20260502_*) のみが実際に適用されます`);

process.exit(failed > 0 ? 1 : 0);

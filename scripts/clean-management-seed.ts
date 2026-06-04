/**
 * scripts/clean-management-seed.ts (feat/starter-data-import / 2026-06-05)
 *
 * 管理テナント (MANAGEMENT_TENANT_ID) の **シードデータ (isSampleData=true)** を削除する。
 * シードデータを「変更」した際 (名前変更・status 変更・本文変更) は、`db:seed:suggestion` の
 * 冪等スキップ (名前/タイトル一致) により旧データが更新されず二重登録になるため、
 * **本スクリプトで旧シードを削除してから再シード** する。
 *
 * ⚠ 安全設計:
 *   - 削除対象は **MANAGEMENT_TENANT_ID かつ isSampleData=true** の Project / Knowledge と、
 *     その配下の Risk/Issue・Retrospective のみ。他テナント・通常データには一切触れない。
 *   - Customer は削除しない (再シードで name 一致により再利用され、重複しないため)。
 *   - 実行には `--yes` フラグ必須 (誤実行防止)。接続先 DB host を表示してから削除する。
 *
 * 使い方:
 *   1. 対象 DB に向ける: .env.local に対象の DATABASE_URL (Transaction pooler 6543) を設定
 *   2. pnpm db:clean:suggestion --yes
 *   3. 続けて pnpm db:seed:suggestion で再投入
 *   4. .env.local を削除 (本番接続情報をローカルに残さない)
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { MANAGEMENT_TENANT_ID } from '../src/lib/tenant';

function maskHost(): string {
  try {
    const u = new URL(process.env.DATABASE_URL ?? '');
    return `${u.host}${u.pathname}`;
  } catch {
    return '(DATABASE_URL 未設定)';
  }
}

async function main() {
  const confirmed = process.argv.includes('--yes');

  console.log('🧹 clean-management-seed');
  console.log(`   DB target: ${maskHost()}`);
  console.log(`   対象: tenant_id=${MANAGEMENT_TENANT_ID} かつ is_sample_data=true の Project/Knowledge + 子の Risk/Retro`);

  if (!confirmed) {
    console.log('\n⚠ ドライラン (削除しません)。実際に削除するには --yes を付けて再実行してください。');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const sampleProjects = await prisma.project.findMany({
      where: { tenantId: MANAGEMENT_TENANT_ID, isSampleData: true },
      select: { id: true },
    });
    const projectIds = sampleProjects.map((p) => p.id);
    const knowledgeCount = await prisma.knowledge.count({
      where: { tenantId: MANAGEMENT_TENANT_ID, isSampleData: true },
    });
    const riskCount = projectIds.length
      ? await prisma.riskIssue.count({ where: { tenantId: MANAGEMENT_TENANT_ID, projectId: { in: projectIds } } })
      : 0;
    const retroCount = projectIds.length
      ? await prisma.retrospective.count({ where: { tenantId: MANAGEMENT_TENANT_ID, projectId: { in: projectIds } } })
      : 0;

    console.log(
      `\n   削除予定: projects=${projectIds.length} knowledge=${knowledgeCount} risks/issues=${riskCount} retrospectives=${retroCount}`,
    );

    if (!confirmed) {
      await prisma.$disconnect();
      return;
    }

    await prisma.$transaction(async (tx) => {
      if (projectIds.length) {
        await tx.riskIssue.deleteMany({ where: { tenantId: MANAGEMENT_TENANT_ID, projectId: { in: projectIds } } });
        await tx.retrospective.deleteMany({ where: { tenantId: MANAGEMENT_TENANT_ID, projectId: { in: projectIds } } });
        // M:N 連結が存在する場合に備えて掃除 (seed 本体は未作成だが防御的に)
        await tx.riskIssueProject.deleteMany({ where: { projectId: { in: projectIds } } });
        await tx.retrospectiveProject.deleteMany({ where: { projectId: { in: projectIds } } });
        await tx.project.deleteMany({ where: { tenantId: MANAGEMENT_TENANT_ID, isSampleData: true } });
      }
      await tx.knowledge.deleteMany({ where: { tenantId: MANAGEMENT_TENANT_ID, isSampleData: true } });
    });

    console.log('\n✅ 管理テナントの旧シードを削除しました。続けて `pnpm db:seed:suggestion` で再投入してください。');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('❌ clean-management-seed 失敗:', e instanceof Error ? e.message : e);
  process.exit(1);
});

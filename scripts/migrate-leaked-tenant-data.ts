/**
 * scripts/migrate-leaked-tenant-data.ts
 *
 * ★severity-1 セキュリティインシデント データ修復 (ADR-0024, 2026-05-28)
 *
 * 用途:
 *   schema.prisma の `tenantId @default(dbgenerated("'00000000-...-001'::uuid"))` バグにより、
 *   `src/services/risk.service.ts createRisk` と `src/services/retrospective.service.ts createRetrospective`
 *   が tenantId を渡さず create していた期間に、本来別テナント所属のレコードが
 *   Default テナント (`00000000-0000-0000-0000-000000000001`) に silent 混入していた。
 *
 *   本スクリプトはそれら混入レコードを **起票者の本来のテナント** に移行する。
 *
 * 動作:
 *   1. RiskIssue / Retrospective テーブルから tenantId = DEFAULT_TENANT_ID のレコードを抽出
 *   2. 起票者 (reporterId / createdBy) のユーザの本来の tenantId を逆引き
 *   3. 起票者の所属が Default 以外なら **そのテナントに UPDATE で戻す**
 *   4. 起票者の所属が Default の場合は正当な Default テナント所有のレコードなのでスキップ
 *
 * 安全策:
 *   - DRY_RUN モード (デフォルト): 何件移動対象かをレポートするだけで UPDATE しない
 *   - `--apply` 指定時のみ実 UPDATE を実行
 *   - すべての操作をログに残し、起票者・移動元・移動先 tenantId を表示
 *
 * 使い方:
 *   pnpm tsx scripts/migrate-leaked-tenant-data.ts             # DRY RUN (推奨初回)
 *   pnpm tsx scripts/migrate-leaked-tenant-data.ts --apply     # 本番適用
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { DEFAULT_TENANT_ID } from '../src/lib/tenant';

const isApply = process.argv.includes('--apply');

type Plan = {
  table: 'risks_issues' | 'retrospectives';
  rowId: string;
  fromTenantId: string;
  toTenantId: string;
  createdByUserId: string;
};

async function buildPlan(prisma: PrismaClient): Promise<Plan[]> {
  const plans: Plan[] = [];

  // ---- RiskIssue (reporterId が起票者) ----
  const riskRows = await prisma.riskIssue.findMany({
    where: { tenantId: DEFAULT_TENANT_ID, deletedAt: null },
    select: { id: true, reporterId: true, createdBy: true, tenantId: true },
  });
  console.log(`[scan] risks_issues: Default テナント所属 ${riskRows.length} 件`);
  for (const r of riskRows) {
    const reporter = await prisma.user.findUnique({
      where: { id: r.reporterId },
      select: { tenantId: true },
    });
    if (!reporter) continue;
    if (reporter.tenantId === DEFAULT_TENANT_ID) continue; // 正当な Default 所属
    plans.push({
      table: 'risks_issues',
      rowId: r.id,
      fromTenantId: DEFAULT_TENANT_ID,
      toTenantId: reporter.tenantId,
      createdByUserId: r.reporterId,
    });
  }

  // ---- Retrospective (createdBy が起票者) ----
  const retroRows = await prisma.retrospective.findMany({
    where: { tenantId: DEFAULT_TENANT_ID, deletedAt: null },
    select: { id: true, createdBy: true, tenantId: true },
  });
  console.log(`[scan] retrospectives: Default テナント所属 ${retroRows.length} 件`);
  for (const r of retroRows) {
    const creator = await prisma.user.findUnique({
      where: { id: r.createdBy },
      select: { tenantId: true },
    });
    if (!creator) continue;
    if (creator.tenantId === DEFAULT_TENANT_ID) continue;
    plans.push({
      table: 'retrospectives',
      rowId: r.id,
      fromTenantId: DEFAULT_TENANT_ID,
      toTenantId: creator.tenantId,
      createdByUserId: r.createdBy,
    });
  }

  return plans;
}

async function applyPlan(prisma: PrismaClient, plans: Plan[]): Promise<void> {
  for (const p of plans) {
    if (p.table === 'risks_issues') {
      await prisma.riskIssue.update({
        where: { id: p.rowId },
        data: { tenantId: p.toTenantId },
      });
    } else {
      await prisma.retrospective.update({
        where: { id: p.rowId },
        data: { tenantId: p.toTenantId },
      });
    }
    console.log(`[apply] ${p.table} ${p.rowId}: ${p.fromTenantId} → ${p.toTenantId} (起票者 ${p.createdByUserId})`);
  }
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    console.log(`mode: ${isApply ? 'APPLY' : 'DRY_RUN'}`);
    const plans = await buildPlan(prisma);

    console.log('');
    console.log(`[summary] 移動対象: ${plans.length} 件`);
    const byTable = plans.reduce<Record<string, number>>((acc, p) => {
      acc[p.table] = (acc[p.table] ?? 0) + 1;
      return acc;
    }, {});
    for (const [table, count] of Object.entries(byTable)) {
      console.log(`  - ${table}: ${count} 件`);
    }
    console.log('');

    if (!isApply) {
      console.log('DRY_RUN: 上記移動内容を実行する場合は `--apply` を付けて再実行してください');
      for (const p of plans) {
        console.log(`  [dry] ${p.table} ${p.rowId}: ${p.fromTenantId} → ${p.toTenantId} (起票者 ${p.createdByUserId})`);
      }
      return;
    }

    await applyPlan(prisma, plans);
    console.log(`[done] ${plans.length} 件のレコードを正しいテナントに移動しました`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

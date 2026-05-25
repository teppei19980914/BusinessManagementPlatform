/**
 * テナント所属テーブルの動的列挙 + ストレージ集計 (ADR-0020 / 2026-05-25)
 *
 * 役割:
 *   旧 [calculateTenantStorageBytes](./tenant-storage.service.ts) は SQL に 16 テーブル名を
 *   ハードコードしていた。新規 model 追加時の SQL 修正漏れで「計測されないテーブル」が発生し、
 *   ユーザに課金できないが Supabase 原価は発生する状態を生む構造的欠陥があった (R1)。
 *
 *   本サービスは:
 *     1. `information_schema.columns` で `tenant_id` カラムを持つテーブルを **動的列挙**
 *     2. tenant_id を持たない JOIN ベースのテーブルは明示的な JOIN_PATTERNS で扱う
 *     3. 両者を UNION ALL で集計 → テナント単位の `pg_column_size` 合計を返す
 *     4. CI ガード ([scripts/verify-tenant-storage-coverage.ts](../../scripts/verify-tenant-storage-coverage.ts))
 *        が schema.prisma の `@@map` と本サービスの結果を照合し、不一致なら CI fail
 *
 * 設計判断:
 *   - **direct (= tenant_id を持つテーブル)**: information_schema 動的列挙で自動追従。
 *     新規 model に tenant_id を生やせば自動で計測対象になる
 *   - **indirect (= JOIN 経由)**: JOIN 構造は schema レベルの設計判断 (例: Task は Project 経由)
 *     なので明示的に JOIN_PATTERNS で管理。schema 変更時に CI ガードが検出
 *
 * SQL injection 防止:
 *   - 動的に table 名を SQL に組み込むため、information_schema からの table 名を allowlist 照合
 *   - JOIN_PATTERNS は静的定義のみ (user input 禁止)
 *
 * 関連:
 *   - ADR: docs/adr/0020-db-capacity-usage-based-billing.md
 *   - 旧実装: src/services/tenant-storage.service.ts (P9-cleanup で廃止予定)
 *   - 使用者: src/services/storage-guard.service.ts (write 時 post-check で呼ぶ)
 *   - CI ガード: scripts/verify-tenant-storage-coverage.ts
 *   - Memory: feedback_3layer_sync_filter.md (テナント関連フィルタは複数レイヤで同期修正)
 */

import { prisma } from '@/lib/db';
import type { Prisma, PrismaClient } from '@/generated/prisma/client';

/** Prisma transaction client (PrismaClient の transaction 内コールバック引数) */
export type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * JOIN ベースで tenant_id にアクセスするテーブルの定義。
 *
 * これらのテーブルは `tenant_id` カラムを持たないが、親テーブル経由でテナントに紐づく。
 * schema.prisma の relations と整合性を保つこと。
 *
 * 構造:
 *   - alias: テーブルの SQL alias (= UNION 内で衝突しないよう短い名前)
 *   - tableName: 物理テーブル名 (= schema.prisma @@map と一致)
 *   - joinClause: tenant_id 持ちテーブルへの JOIN
 *   - tenantIdSource: WHERE 句で tenant_id を参照する alias (= 親テーブルの alias)
 */
type JoinBasedTable = {
  readonly alias: string;
  readonly tableName: string;
  readonly joinClause: string;
  readonly tenantIdSource: string;
};

export const JOIN_BASED_TABLES: readonly JoinBasedTable[] = [
  {
    alias: 't',
    tableName: 'tasks',
    joinClause: 'JOIN projects p ON t.project_id = p.id',
    tenantIdSource: 'p',
  },
  {
    alias: 'tpl',
    tableName: 'task_progress_logs',
    joinClause: 'JOIN tasks tsk ON tpl.task_id = tsk.id JOIN projects p ON tsk.project_id = p.id',
    tenantIdSource: 'p',
  },
  {
    alias: 'e',
    tableName: 'estimates',
    joinClause: 'JOIN projects p ON e.project_id = p.id',
    tenantIdSource: 'p',
  },
  {
    alias: 'pm',
    tableName: 'project_members',
    joinClause: 'JOIN projects p ON pm.project_id = p.id',
    tenantIdSource: 'p',
  },
  {
    alias: 'kp',
    tableName: 'knowledge_projects',
    joinClause: 'JOIN knowledges k ON kp.knowledge_id = k.id',
    tenantIdSource: 'k',
  },
  {
    alias: 'tk',
    tableName: 'task_knowledges',
    joinClause: 'JOIN knowledges k ON tk.knowledge_id = k.id',
    tenantIdSource: 'k',
  },
  {
    alias: 'rip',
    tableName: 'risk_issue_projects',
    joinClause: 'JOIN risks_issues r ON rip.risk_issue_id = r.id',
    tenantIdSource: 'r',
  },
  {
    alias: 'rpr',
    tableName: 'retrospective_projects',
    joinClause: 'JOIN retrospectives rt ON rpr.retrospective_id = rt.id',
    tenantIdSource: 'rt',
  },
] as const;

/** JOIN_BASED_TABLES に含まれる物理テーブル名 (= CI ガード照合用) */
export const JOIN_BASED_TABLE_NAMES: readonly string[] = JOIN_BASED_TABLES.map(
  (j) => j.tableName,
);

/**
 * tenant_id を持つ direct テーブル名一覧を information_schema から取得する。
 *
 * フィルタ:
 *   - column_name='tenant_id' を持つテーブル
 *   - table_schema='public'
 *   - JOIN_BASED_TABLES と重複しないこと (= 念のための allowlist 排他)
 *
 * @returns 物理テーブル名の配列 (例: ['tenants', 'users', 'projects', ...])
 */
export async function getDirectTenantScopedTables(
  tx: TxClient | PrismaClient = prisma,
): Promise<string[]> {
  type Row = { table_name: string };
  const rows = await (
    tx as unknown as { $queryRaw: typeof prisma.$queryRaw }
  ).$queryRaw<Row[]>`
    SELECT table_name
      FROM information_schema.columns
     WHERE column_name = 'tenant_id'
       AND table_schema = 'public'
     ORDER BY table_name
  `;
  return rows.map((r) => r.table_name);
}

/**
 * tenant_id を持つ direct + JOIN ベース全テーブルの一覧 (CI ガード用)。
 *
 * @returns 物理テーブル名の sorted unique 配列
 */
export async function getAllTenantScopedTables(
  tx: TxClient | PrismaClient = prisma,
): Promise<string[]> {
  const direct = await getDirectTenantScopedTables(tx);
  const all = new Set<string>([...direct, ...JOIN_BASED_TABLE_NAMES]);
  return Array.from(all).sort();
}

/**
 * テナント単位で全関連テーブルの `pg_column_size` を集計し、合計バイト数を返す (動的版)。
 *
 * 旧 calculateTenantStorageBytes (= 16 テーブルハードコード) の置き換え。
 * 新規 tenant_id 持ちテーブルが追加されても自動で集計対象に含まれる。
 *
 * パフォーマンス: 各テーブルは tenant_id インデックスがあるので O(対象行数)。
 *   テーブル数が増えると線形にクエリコスト増 (40+ テーブルで 数百ミリ秒 〜 数秒目安)。
 *
 * @param tenantId UUID
 * @param tx 任意の prisma client (= storage-guard では tx 内で呼ぶ必要あり)
 * @returns 合計バイト数 (BigInt)
 */
export async function calculateTenantStorageBytesDynamic(
  tenantId: string,
  tx: TxClient | PrismaClient = prisma,
): Promise<bigint> {
  const directTables = await getDirectTenantScopedTables(tx);

  // SQL injection 防止: テーブル名は information_schema 由来 + allowlist パターン照合のみ通す
  const validTablePattern = /^[a-z_][a-z0-9_]*$/;
  const safeDirectTables = directTables.filter((t) => validTablePattern.test(t));
  if (safeDirectTables.length !== directTables.length) {
    throw new Error(
      `[tenant-storage-tables] unsafe table name detected: ${JSON.stringify(directTables)}`,
    );
  }

  // direct テーブル分の SELECT 文を組立
  // 各 SELECT は (SELECT SUM(pg_column_size(t.*))::bigint FROM table_name t WHERE t.tenant_id = $1::uuid)
  const directSelects = safeDirectTables.map(
    (tableName) =>
      `COALESCE((SELECT SUM(pg_column_size(__t.*))::bigint FROM "${tableName}" __t WHERE __t.tenant_id = $1::uuid), 0)`,
  );

  // JOIN ベーステーブル分の SELECT 文を組立
  const joinSelects = JOIN_BASED_TABLES.map(
    (j) =>
      `COALESCE((SELECT SUM(pg_column_size(${j.alias}.*))::bigint FROM "${j.tableName}" ${j.alias} ${j.joinClause} WHERE ${j.tenantIdSource}.tenant_id = $1::uuid), 0)`,
  );

  const allSelects = [...directSelects, ...joinSelects].join(' + ');
  const sql = `SELECT (${allSelects})::bigint AS total_bytes`;

  type Row = { total_bytes: bigint };
  const rows = await (
    tx as unknown as { $queryRawUnsafe: typeof prisma.$queryRawUnsafe }
  ).$queryRawUnsafe<Row[]>(sql, tenantId);

  return rows[0]?.total_bytes ?? BigInt(0);
}

/**
 * pg_database_size を取得する (drift 検知用、ADR-0020 §3.5)。
 *
 * Supabase 実請求対象との突合用。`calculateTenantStorageBytesDynamic` の全テナント SUM
 * との乖離が DB_DRIFT_WARNING_RATIO 超なら super_admin alert。
 *
 * @returns 現在の DB 全体サイズ (バイト)
 */
export async function getDbInstanceSizeBytes(
  tx: TxClient | PrismaClient = prisma,
): Promise<bigint> {
  type Row = { db_size: bigint };
  const rows = await (
    tx as unknown as { $queryRaw: typeof prisma.$queryRaw }
  ).$queryRaw<Row[]>`SELECT pg_database_size(current_database())::bigint AS db_size`;
  return rows[0]?.db_size ?? BigInt(0);
}

// テスト用 export (Prisma type に依存しない方式での透過)
export const _internals = {
  JOIN_BASED_TABLES,
  JOIN_BASED_TABLE_NAMES,
};

// Re-export for convenience
export type { Prisma };

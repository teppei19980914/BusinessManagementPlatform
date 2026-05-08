/**
 * DB 容量モニタサービス (P-5a / 2026-05-08)
 *
 * 役割:
 *   PostgreSQL の使用容量を `pg_database_size()` で実測し、Supabase プラン上限との
 *   比率からステータスを算出する。super_admin ダッシュボードで「DB 容量上限到達による
 *   データ登録不能」事故の事前検知に使う。
 *
 * 設計判断:
 *   - **prisma.$queryRaw で生 SQL を発行**: pg_database_size / pg_total_relation_size は
 *     Prisma model にマッピングできない system function のため。
 *   - **テーブル別内訳は pg_total_relation_size を採用**: index + toast を含む
 *     「実際にディスクを占有する総量」を返す (= プラン課金の対象に近い)。
 *   - **deletedAt で論理削除した行も容量を消費する**: VACUUM が走るまで物理サイズに
 *     残るため、運用負荷の正確な可視化には適切。
 *   - **管理者専用**: 呼出側で `isSuperAdmin(user)` を確認した前提 (本サービスでは検証しない)。
 *
 * 認可境界:
 *   - 本ファイルは生 SQL を実行するため、必ず super_admin role 経由でのみ呼ぶこと。
 *   - 外部入力は受け付けない (引数なし) ため SQL injection リスクなし。
 *
 * 関連:
 *   - 計画: docs/roadmap/V1_FINAL_TASKS.md P-5
 *   - 設定: src/config/db-capacity.ts (閾値・上限)
 *   - UI: src/app/(dashboard)/admin/super/page.tsx (容量カード)
 *   - 認可ヘルパ: src/lib/permissions/role.ts (isSuperAdmin)
 */

import { prisma } from '@/lib/db';
import {
  classifyDbCapacityStatus,
  getDbCapacityLimitBytes,
  DB_CAPACITY_TOP_TABLES_LIMIT,
  type DbCapacityStatus,
} from '@/config/db-capacity';

// ================================================================
// 公開型
// ================================================================

export type TableSizeRow = {
  /** テーブル名 (public schema 限定) */
  tableName: string;
  /** index + toast を含む総バイト数 */
  totalBytes: number;
};

export type DbCapacityReport = {
  /** DB 全体の使用バイト数 */
  usedBytes: number;
  /** 設定された上限バイト数 (env or default) */
  limitBytes: number;
  /** 使用率 (0.0-1.0+, 上限超過時は 1 を超え得る) */
  utilizationRatio: number;
  /** ステータス分類 (ok / warn / alert) */
  status: DbCapacityStatus;
  /** 容量上位テーブル (実装側でフィルタ済み = top N 件) */
  topTables: TableSizeRow[];
  /** 計測時刻 */
  measuredAt: Date;
};

// ================================================================
// 公開関数
// ================================================================

/**
 * DB 容量と上位テーブル内訳を取得する。
 *
 * pg_database_size() で実測した bytes と config の上限値からステータスを算出。
 * テーブル内訳は public schema のみ対象 (システムテーブルは除外)。
 *
 * @returns 計測時点の容量レポート
 */
export async function getDatabaseCapacityReport(): Promise<DbCapacityReport> {
  const usedBytes = await getDatabaseSize();
  const topTables = await getTopTablesBySize(DB_CAPACITY_TOP_TABLES_LIMIT);
  const limitBytes = getDbCapacityLimitBytes();

  return {
    usedBytes,
    limitBytes,
    utilizationRatio: limitBytes > 0 ? usedBytes / limitBytes : 0,
    status: classifyDbCapacityStatus(usedBytes, limitBytes),
    topTables,
    measuredAt: new Date(),
  };
}

/**
 * DB 全体のサイズを取得 (バイト)。
 * 単独テスト用に export しているが、通常は getDatabaseCapacityReport を使う。
 */
export async function getDatabaseSize(): Promise<number> {
  // pg_database_size は BIGINT を返すので Prisma の戻り値は bigint
  const rows = await prisma.$queryRaw<Array<{ size: bigint }>>`
    SELECT pg_database_size(current_database()) AS size
  `;
  const size = rows[0]?.size ?? BigInt(0);
  // JS の Number は 2^53 までだが Supabase の上限 (TB 級) でも十分カバー
  return Number(size);
}

/**
 * 容量上位テーブルを取得 (バイト降順 / public schema 限定)。
 *
 * pg_total_relation_size は table + index + toast の合計バイト数。
 * 通常テーブルのみ対象 (system catalog は schemaname='public' 条件で除外)。
 */
export async function getTopTablesBySize(limit: number): Promise<TableSizeRow[]> {
  // limit は数値 (number) 型を確認した上で template literal に直接埋め込む。
  // prisma.$queryRaw の template literal binding は LIMIT 句に使えないため、
  // 整数化 + 範囲制限で injection を防ぐ。
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));

  const rows = await prisma.$queryRaw<Array<{ table_name: string; total_bytes: bigint }>>`
    SELECT
      C.relname AS table_name,
      pg_total_relation_size(C.oid) AS total_bytes
    FROM pg_class C
    LEFT JOIN pg_namespace N ON (N.oid = C.relnamespace)
    WHERE N.nspname = 'public'
      AND C.relkind = 'r'
    ORDER BY pg_total_relation_size(C.oid) DESC
    LIMIT ${safeLimit}
  `;

  return rows.map((r) => ({
    tableName: r.table_name,
    totalBytes: Number(r.total_bytes),
  }));
}

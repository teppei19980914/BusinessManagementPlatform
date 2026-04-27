/**
 * 監査ログ記録（設計書: DESIGN.md セクション 5.13）
 *
 * 全てのデータ変更操作（CREATE / UPDATE / DELETE）を記録する。
 * 初期フェーズ（Level 1）で常時有効。
 */

import { prisma } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';

/**
 * 監査ログのアクション種別。
 * SYNC_IMPORT は feat/wbs-overwrite-import で追加 (WBS 上書きインポート 1 件 = 1 ログ)。
 */
export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'SYNC_IMPORT';

export async function recordAuditLog(params: {
  userId: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  beforeValue?: Record<string, unknown> | null;
  afterValue?: Record<string, unknown> | null;
  ipAddress?: string;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId: params.userId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      beforeValue: (params.beforeValue ?? undefined) as Prisma.InputJsonValue | undefined,
      afterValue: (params.afterValue ?? undefined) as Prisma.InputJsonValue | undefined,
      ipAddress: params.ipAddress,
    },
  });
}

/**
 * 複数エンティティに対する一括操作の監査ログを `createMany` で一度に記録する。
 *
 * なぜこの関数が必要か:
 * - AuditLog スキーマの entityId は `@db.Uuid` 型であり、`"bulk:24"` のような
 *   合成文字列を入れると DB レベルで拒否される（PrismaClientKnownRequestError P2007）
 * - 正しい監査の粒度は「エンティティごとに 1 行」。バルク操作の文脈は afterValue の
 *   メタデータ（bulk: true, bulkBatchSize, 適用した updates 等）で保持する
 */
export async function recordBulkAuditLogs(params: {
  userId: string;
  action: AuditAction;
  entityType: string;
  /** 監査対象の各 UUID（バリデーション済みであること）*/
  entityIds: string[];
  /** 全エンティティ共通の afterValue。バルク適用内容を含めるとトレーサビリティが向上する */
  afterValue?: Record<string, unknown> | null;
  beforeValue?: Record<string, unknown> | null;
  ipAddress?: string;
}): Promise<void> {
  if (params.entityIds.length === 0) return;
  await prisma.auditLog.createMany({
    data: params.entityIds.map((entityId) => ({
      userId: params.userId,
      action: params.action,
      entityType: params.entityType,
      entityId, // 個別の UUID を設定（合成文字列を避ける）
      beforeValue: (params.beforeValue ?? undefined) as Prisma.InputJsonValue | undefined,
      afterValue: (params.afterValue ?? undefined) as Prisma.InputJsonValue | undefined,
      ipAddress: params.ipAddress,
    })),
  });
}

/**
 * 変更前後の差分を抽出するヘルパー
 * password_hash 等の機密フィールドは自動的に除外する。
 */
const SENSITIVE_FIELDS = new Set([
  'passwordHash',
  'password_hash',
  'mfaSecretEncrypted',
  'mfa_secret_encrypted',
]);

export function sanitizeForAudit(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_FIELDS.has(key)) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

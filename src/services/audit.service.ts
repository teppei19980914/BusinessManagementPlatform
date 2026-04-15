/**
 * 監査ログ記録（設計書: DESIGN.md セクション 5.13）
 *
 * 全てのデータ変更操作（CREATE / UPDATE / DELETE）を記録する。
 * 初期フェーズ（Level 1）で常時有効。
 */

import { prisma } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE';

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

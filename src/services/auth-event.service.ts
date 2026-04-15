/**
 * 認証イベントログ記録（設計書: DESIGN.md セクション 9.4.5）
 *
 * ログイン成功/失敗、ログアウト、パスワード変更等を記録する。
 * 初期フェーズ（Level 1）で常時有効。
 */

import { prisma } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';

export type AuthEventType =
  | 'login_success'
  | 'login_failure'
  | 'logout'
  | 'lock'
  | 'password_change'
  | 'account_created'
  | 'account_deactivated'
  | 'account_reactivated';

export async function recordAuthEvent(params: {
  eventType: AuthEventType;
  userId?: string;
  email?: string;
  ipAddress?: string;
  userAgent?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await prisma.authEventLog.create({
    data: {
      eventType: params.eventType,
      userId: params.userId,
      email: params.email,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      detail: (params.detail ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

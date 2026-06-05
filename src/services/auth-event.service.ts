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
  // 2026-06-03 (feat/logout-other-devices): 「他の端末からログアウト」操作。
  //   呼出端末以外の全セッションを tokenVersion increment で無効化したイベント。
  | 'logout_other_devices'
  | 'lock'
  | 'password_change'
  | 'account_created'
  | 'account_deactivated'
  | 'account_reactivated';

export async function recordAuthEvent(params: {
  eventType: AuthEventType;
  /**
   * Phase 2-10 (2026-05-10): 認証イベントの所属テナント (NULL 許容)。
   *   - 通常 (userId が解決済) は user.tenantId を渡す
   *   - pre-auth 失敗 (login_failure with email-not-found) は **NULL** のまま記録
   *   - email から user 解決済の login_failure (パスワード誤り等) では tenantId を渡す
   */
  tenantId?: string | null;
  userId?: string;
  email?: string;
  ipAddress?: string;
  userAgent?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await prisma.authEventLog.create({
    data: {
      eventType: params.eventType,
      tenantId: params.tenantId ?? undefined,
      userId: params.userId,
      email: params.email,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      detail: (params.detail ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

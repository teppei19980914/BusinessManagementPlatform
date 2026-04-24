/**
 * 未使用アカウント自動削除バッチ（設計書: SPECIFICATION.md セクション 13.13）
 * Vercel Cron Jobs または外部スケジューラから日次で呼び出す想定
 *
 * - 30日未ログイン → 論理削除
 * - 60日未ログイン（論理削除から30日） → 物理削除（個人情報匿名化）
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { recordAuthEvent } from '@/services/auth-event.service';

export async function POST(req: NextRequest) {
  // PR #114 (2026-04-24 セキュリティ監査): CRON_SECRET が未設定の場合でも
  // 必ず 401 を返す (旧実装は `if (cronSecret && …)` の短絡で未設定時に認証バイパス
  // 可能だった — Network タブ経由で全ユーザの論理削除・匿名化が外部から匿名 POST できた)。
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  // ステップ1: 30日未ログイン → 論理削除（システム管理者は除外）
  const toDeactivate = await prisma.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      systemRole: { not: 'admin' },
      lastLoginAt: { lt: thirtyDaysAgo },
    },
  });

  for (const user of toDeactivate) {
    await prisma.user.update({
      where: { id: user.id },
      data: { isActive: false, deletedAt: now },
    });
    await recordAuthEvent({
      eventType: 'account_deactivated',
      userId: user.id,
      detail: { action: 'auto_deactivated', lastLoginAt: user.lastLoginAt?.toISOString() },
    });
  }

  // ステップ2: 論理削除から30日経過 → 物理削除（個人情報匿名化）
  const toPurge = await prisma.user.findMany({
    where: {
      isActive: false,
      deletedAt: { lt: sixtyDaysAgo },
      systemRole: { not: 'admin' },
    },
  });

  for (const user of toPurge) {
    // 個人情報を匿名化
    await prisma.user.update({
      where: { id: user.id },
      data: {
        name: '削除済みユーザ',
        email: `deleted_${user.id}@deleted.local`,
        passwordHash: 'PURGED',
      },
    });

    // 関連データを削除
    await prisma.recoveryCode.deleteMany({ where: { userId: user.id } });
    await prisma.passwordHistory.deleteMany({ where: { userId: user.id } });
    await prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } });
    await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
    await prisma.session.deleteMany({ where: { userId: user.id } });

    await recordAuthEvent({
      eventType: 'account_deactivated',
      userId: user.id,
      detail: { action: 'auto_purged' },
    });
  }

  return NextResponse.json({
    data: {
      deactivated: toDeactivate.length,
      purged: toPurge.length,
    },
  });
}

/**
 * POST /api/auth/delete-account - アカウント自己削除 (退会)
 *
 * 役割:
 *   ログイン中ユーザが自分のアカウントを削除する。パスワード再入力で本人確認後、
 *   論理削除 (deletedAt) + isActive=false を設定。データ参照整合性維持のため、
 *   作成済みのリスク・タスク等は削除されず作成者として残る。
 *
 * 認可: getAuthenticatedUser (本人のみ。パスワード再入力で本人確認)
 * 監査:
 *   - audit_logs (action=DELETE, entityType=user)
 *   - auth_event_logs (eventType=account_self_deleted)
 *
 * 関連:
 *   - DESIGN.md §9 (アカウント削除フロー)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { compare } from 'bcryptjs';
import { recordAuthEvent } from '@/services/auth-event.service';
import { recordAuditLog } from '@/services/audit.service';
import { z } from 'zod/v4';

const deleteSchema = z.object({
  password: z.string().min(1),
  recoveryCode: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const t = await getTranslations('message');

  const body = await req.json();
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  // パスワード確認
  const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
  if (!dbUser) {
    return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }

  const isValidPassword = await compare(parsed.data.password, dbUser.passwordHash);
  if (!isValidPassword) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: t('wrongPassword') } },
      { status: 400 },
    );
  }

  // リカバリーコード確認
  const codes = await prisma.recoveryCode.findMany({
    where: { userId: user.id, usedAt: null },
  });

  let matched = false;
  for (const code of codes) {
    const isMatch = await compare(parsed.data.recoveryCode, code.codeHash);
    if (isMatch) {
      await prisma.recoveryCode.update({ where: { id: code.id }, data: { usedAt: new Date() } });
      matched = true;
      break;
    }
  }

  if (!matched) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: t('wrongRecoveryCode') } },
      { status: 400 },
    );
  }

  // 論理削除
  await prisma.user.update({
    where: { id: user.id },
    data: { isActive: false, deletedAt: new Date() },
  });

  // プロジェクトメンバーシップ解除
  await prisma.projectMember.deleteMany({ where: { userId: user.id } });

  // セッション無効化
  await prisma.session.deleteMany({ where: { userId: user.id } });

  await recordAuditLog({
    userId: user.id,
    action: 'DELETE',
    entityType: 'user',
    entityId: user.id,
    afterValue: { action: 'self_delete' },
  });

  await recordAuthEvent({
    eventType: 'account_deactivated',
    userId: user.id,
    detail: { action: 'self_delete' },
  });

  return NextResponse.json({ data: { success: true } });
}

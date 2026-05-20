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
    // §5.33: t は使用するエラー分岐内で local 取得 (top-level だと validation 失敗時に無駄な await)
    const t = await getTranslations('message');
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
    const t = await getTranslations('message');
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: t('wrongRecoveryCode') } },
      { status: 400 },
    );
  }

  // feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S1-D1): severity-1 transaction 化。
  //   旧実装は 4 ステップ (user.update / findMany / createMany / deleteMany) すべて transaction 外で
  //   process crash により中間状態残存 (deletedAt=true だが projectMember 残存等) のリスクがあった。
  //   user 論理削除 + メンバー解除履歴記録 + メンバー解除 + session 無効化を 1 transaction に集約し、
  //   失敗時は全ロールバックすることで監査ログ消失パスを構造的に排除する。
  //
  //   memberships の findMany も transaction 内に移動し、findMany ↔ deleteMany 間の race も排除
  //   (並列で admin が projectMember を作成しても、transaction の SERIALIZABLE 等価で
  //    新行は次回再試行サイクルで反映される)。
  //
  //   recordAuditLog / recordAuthEvent は副作用 (audit_logs / auth_event_logs への INSERT) のみで
  //   失敗しても本処理は通すべき (= 削除完了優先) ため、transaction の外側に維持。
  await prisma.$transaction(async (tx) => {
    // 論理削除
    await tx.user.update({
      where: { id: user.id },
      data: { isActive: false, deletedAt: new Date() },
    });

    // プロジェクトメンバーシップ取得 → role_change_logs に解除記録
    const memberships = await tx.projectMember.findMany({
      where: { userId: user.id },
      select: { id: true, projectId: true, projectRole: true },
    });
    if (memberships.length > 0) {
      await tx.roleChangeLog.createMany({
        data: memberships.map((m) => ({
          tenantId: user.tenantId,
          changedBy: user.id,
          targetUserId: user.id,
          changeType: 'project_role',
          projectId: m.projectId,
          beforeRole: m.projectRole,
          afterRole: 'removed',
          reason: 'アカウント削除によるメンバー解除',
        })),
      });
    }

    // プロジェクトメンバーシップ解除
    await tx.projectMember.deleteMany({ where: { userId: user.id } });

    // セッション無効化
    await tx.session.deleteMany({ where: { userId: user.id } });
  });

  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'DELETE',
    entityType: 'user',
    entityId: user.id,
    afterValue: { action: 'self_delete' },
  });

  await recordAuthEvent({
    eventType: 'account_deactivated',
    tenantId: user.tenantId,
    userId: user.id,
    detail: { action: 'self_delete' },
  });

  return NextResponse.json({ data: { success: true } });
}

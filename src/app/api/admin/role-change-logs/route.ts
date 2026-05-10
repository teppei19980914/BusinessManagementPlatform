/**
 * GET /api/admin/role-change-logs - 権限変更履歴取得
 *
 * 役割:
 *   システムロール / プロジェクトロール変更の履歴 (role_change_logs) を一覧表示。
 *   「誰が誰のどのロールを何時いつ変更したか」を監査目的で追跡可能にする。
 *
 * 認可: requireAdmin (システム管理者のみ)
 *
 * 関連:
 *   - DESIGN.md §5 (テーブル定義: role_change_logs)
 *   - DESIGN.md §9 (セキュリティ設計 / 権限変更の追跡)
 *   - SPECIFICATION.md (権限変更画面)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const { searchParams } = req.nextUrl;
  const page = Number(searchParams.get('page')) || 1;
  const limit = Math.min(Number(searchParams.get('limit')) || 50, 100);

  // 2026-05-10 Phase 2-10: RoleChangeLog 直接 tenantId 列で絞込み (Phase 2-9 で導入した targetUser join 経由から移行)。
  //   Phase 2-10 schema migration で role_change_logs.tenant_id 列が追加されたため有効に。
  //   indexed lookup で高速、target user 物理削除後も追従可能。
  const where = { tenantId: user.tenantId };
  const [logs, total] = await Promise.all([
    prisma.roleChangeLog.findMany({
      where,
      include: {
        changer: { select: { name: true } },
        targetUser: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.roleChangeLog.count({ where }),
  ]);

  const data = logs.map((l) => ({
    id: l.id,
    changerName: l.changer.name,
    targetUserName: l.targetUser.name,
    targetUserEmail: l.targetUser.email,
    changeType: l.changeType,
    beforeRole: l.beforeRole,
    afterRole: l.afterRole,
    reason: l.reason,
    createdAt: l.createdAt.toISOString(),
  }));

  return NextResponse.json({ data, meta: { total, page, limit } });
}

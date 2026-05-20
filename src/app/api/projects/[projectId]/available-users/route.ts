/**
 * GET /api/projects/[projectId]/available-users - メンバー追加候補ユーザ一覧
 *
 * 役割:
 *   メンバー管理タブの「メンバー追加」ダイアログで、追加候補ユーザの SearchableSelect に
 *   表示する自テナント内のアクティブユーザ一覧を返す。最小限のフィールド (id, name, email,
 *   isActive) のみで、admin/users エンドポイントが扱う機微情報 (lockedUntil, MFA 状態,
 *   failedLoginCount 等) は含まない。
 *
 * 認可: member:manage (admin + pm_tl)
 *   feat/crud-permission-redesign (2026-05-20): PM/TL もメンバー追加可能になったため、
 *   /api/admin/users (admin only) とは独立した PM/TL も叩ける endpoint として新設。
 *
 * テナント越境: tenantId = user.tenantId で必ず絞り込み (severity-1 防御)。
 *
 * 関連:
 *   - src/services/member.service.ts addMember (細粒度 pm_tl ガード)
 *   - src/app/(dashboard)/projects/[projectId]/members-client.tsx (UI 利用箇所)
 */

import { NextResponse } from 'next/server';
import {
  getAuthenticatedUser,
  checkProjectPermission,
} from '@/lib/api-helpers';
import { prisma } from '@/lib/db';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'member:manage');
  if (forbidden) return forbidden;

  // テナント越境防止 + アクティブユーザのみ + 論理削除済ユーザは除外
  const users = await prisma.user.findMany({
    where: { tenantId: user.tenantId, isActive: true, deletedAt: null },
    select: { id: true, name: true, email: true, isActive: true },
    orderBy: { name: 'asc' },
  });

  return NextResponse.json({ data: users });
}

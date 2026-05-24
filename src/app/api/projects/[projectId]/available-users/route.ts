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
 * 上限 (PR fix/chat-search-and-auto-open / 2026-05-24):
 *   `take: AVAILABLE_USERS_MAX` で結果件数を上限化。
 *   旧仕様は無制限 findMany で、テナント全アクティブユーザ列挙が走る経路だった。
 *   member:manage 権限を持つユーザが連投すれば DB 負荷の DoS が成立しうるため、
 *   SearchableSelect の現実的な表示件数を踏まえて上限を導入。500 件を超えるテナント
 *   サイズになった場合は keyword フィルタ追加 (UI 拡張) で対応する。
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

/**
 * 1 リクエストで返す候補ユーザの最大件数。
 * SearchableSelect の現実的描画限界 + DB DoS 防御の二段の理由で設定。
 */
const AVAILABLE_USERS_MAX = 500;

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
  // take 上限 = AVAILABLE_USERS_MAX (DoS 防御)
  const users = await prisma.user.findMany({
    where: { tenantId: user.tenantId, isActive: true, deletedAt: null },
    select: { id: true, name: true, email: true, isActive: true },
    orderBy: { name: 'asc' },
    take: AVAILABLE_USERS_MAX,
  });

  return NextResponse.json({ data: users });
}

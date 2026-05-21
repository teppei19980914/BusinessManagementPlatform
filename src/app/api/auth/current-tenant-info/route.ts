/**
 * GET /api/auth/current-tenant-info ─ 認証済ユーザの所属テナントの {slug, name} を返す軽量 endpoint。
 *
 * 用途 (PR #420 補足対応):
 *   ログイン成功直後に login 画面が呼び、{slug, name} を localStorage の tenant 履歴 (LRU 5 件)
 *   に保存する。同じブラウザの次回ログインで自動入力 / プルダウン表示に使う。
 *
 * 認可:
 *   getAuthenticatedUser のみ (= login 済 + tokenVersion 一致 + active)。
 *   admin 権限不要 (= login さえできる人なら自分のテナントの slug / name は当然見られる)。
 *
 * セキュリティ:
 *   - **自分が所属するテナントの slug / name しか返さない** (列挙不可)
 *   - tenantId (UUID) は返さない (slug + name で UI には十分、UUID は内部識別子)
 *   - 既存 /api/tenants/me と異なり admin 権限不要だが、別途プラン情報等の機密値は返さない
 *
 * 関連:
 *   - src/app/(auth)/login/page.tsx (利用元)
 *   - src/lib/tenant-history.ts (受け取った {slug, name} を localStorage に保存)
 */

import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  // 自分の tenantId から slug + name のみ取得 (他フィールドは返さない)
  const tenant = await prisma.tenant.findFirst({
    where: { id: user.tenantId, deletedAt: null },
    select: { slug: true, name: true },
  });

  if (!tenant) {
    // ログイン直後にここに来るのは race condition (テナント削除と同時等) のみ。
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'テナントが見つかりません' } },
      { status: 404 },
    );
  }

  return NextResponse.json({ data: { slug: tenant.slug, name: tenant.name } });
}

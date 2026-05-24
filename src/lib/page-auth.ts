/**
 * Server Component (layout.tsx / page.tsx) 用の認証ガード
 *
 * 役割:
 *   `src/lib/api-helpers.ts` の `getAuthenticatedUser()` と同等の `tokenVersion` 検証を
 *   Server Component 経路にも適用する。`auth()` は JWT 署名検証のみで通すため、
 *   ログアウト時に increment された tokenVersion を検出できず、旧 cookie 残留時に
 *   「他人になりすました状態のページ描画」が起きうる (KDD §5.X+72 / fix/session-clearance)。
 *
 * 設計:
 *   - 失敗時は `NextResponse` ではなく `redirect()` を throw する (Server Component の規約)
 *   - 戻り値: 後方互換のため `session.user` 全体を返す。dashboard layout は user object を
 *     そのまま `<AppHeader user={...} />` に渡しており、形状変更は局所差し替えにとどめる
 *   - 性能影響: layout レンダリング毎に `prisma.user.findUnique` が 1 回追加 (~5ms / Pooler)
 *
 * 関連:
 *   - 元実装: `src/lib/api-helpers.ts:47-79` `getAuthenticatedUser` (API route 向け)
 *   - explicit-signout が tokenVersion increment した結果を Server Component 層でも検出
 */

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { LOGIN_ROUTE } from '@/config';
import type { Session } from 'next-auth';

/**
 * 認証済み layout 向けに session を返す。未認証 / 失効済の場合は `/login` に redirect する。
 *
 * tokenVersion 不一致 (= ログアウトや admin による強制失効) を検出した時点で、
 * Server Component 配下の `prisma` クエリが古い `tenantId` で実行されないよう描画を中断する。
 */
export async function requireAuthForLayout(): Promise<Session['user']> {
  const session = await auth();
  if (!session) {
    redirect(LOGIN_ROUTE);
  }

  const jwtTokenVersion = session.user.tokenVersion ?? 0;
  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { tokenVersion: true, isActive: true, deletedAt: true },
  });
  if (
    !dbUser
    || dbUser.deletedAt !== null
    || !dbUser.isActive
    || dbUser.tokenVersion !== jwtTokenVersion
  ) {
    redirect(LOGIN_ROUTE);
  }

  return session.user;
}

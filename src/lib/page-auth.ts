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

/**
 * 公開ページ (認証不要) layout 向けに「あれば検証済 user、なければ null」を返す
 * (feat/app-header-footer-unification / 2026-05-24 / KDD §5.X+120)。
 *
 * 用途:
 *   /changelog, /announcements 等の (public) ページ群。これらは未認証でも閲覧可能だが、
 *   ログイン済ユーザがアクセスしてきた場合は AppHeader にナビ + AccountMenu を表示したい。
 *   ただし `await auth()` をそのまま呼ぶと:
 *     1. tokenVersion 検証が抜け、失効済 cookie で「他人としてログイン状態」と誤検知される
 *        (= AppHeader が他人の名前を表示する severity-1 個人情報漏洩)
 *     2. CI ガード scripts/check-banned-auth-patterns.ts に引っかかって fail する
 *
 *   `requireAuthForLayout()` を使えば 1 は防げるが、未認証時に /login へ redirect するため
 *   public ページが閲覧不能になる。両方を満たす中間ヘルパが本関数。
 *
 * 動作:
 *   - 未認証 (session=null): redirect せず null を返す → AppHeader は user=null モード
 *   - 認証済 + tokenVersion 一致 + isActive: user を返す → AppHeader はログイン後モード
 *   - 認証済 だが tokenVersion 不一致 / 失効 / 退会: null を返す (redirect しない)
 *     → public ページは閲覧可能だが「ログイン状態」として誤表示しない (安全側に倒す)
 *
 * tokenVersion 検証が抜けたまま session.user を信じると、
 * fix/session-clearance (PR #415 / KDD §5.X+72, §5.X+84) で塞いだ「Netlify Set-Cookie 脱落
 * → 旧 cookie 残留 → 他人なりすまし」経路が public layout 側で復活する。本関数で同水準の
 * 検証を行うことでその穴を塞ぐ。
 */
export async function optionalAuthForLayout(): Promise<Session['user'] | null> {
  const session = await auth();
  if (!session) return null;

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
    // 失効した cookie を信じてはいけない (個人情報漏洩防止)。public ページの閲覧は許可しつつ、
    // 「ログイン状態」としては扱わない。
    return null;
  }

  return session.user;
}

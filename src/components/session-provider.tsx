'use client';

/**
 * Client Component ラッパー (PR #67 / PR #119 拡張): NextAuth v5 の SessionProvider を
 * root layout から使えるように client 境界に切り出す。
 *
 * PR #119: `session` prop を受け取り、SessionProvider の初期値として渡すようにした。
 *   これにより `useSession()` の第 1 レンダリングで session が確定しており、
 *   i18n 描画 (useFormatters 経由で timezone/locale を解決) がハイドレーション安全になる。
 *   (従来は undefined → mount 後 fetch → 再描画で値確定、の経路だった。)
 *
 * perf/comprehensive-perf-2026-06-01 (E):
 *   本番計測で /api/auth/session が 1 ページ表示中に 4 回 fetch されることを観測 (累計 ~3s)。
 *   NextAuth v5 既定値 `refetchOnWindowFocus=true` がタブ復帰のたび、`refetchInterval` 未指定の
 *   既定挙動 (内部 0 だが session 取得直後に validity refresh を試みる) と相まって過剰 fetch が発生していた。
 *
 *   設計判断:
 *   - **refetchInterval={0}**: 定期 polling を完全停止 (= session 期限切れの検知はサーバ middleware に任せる)
 *   - **refetchOnWindowFocus={false}**: window focus 復帰時の再 fetch を停止
 *
 *   セキュリティ・UX への影響:
 *   - **セキュリティ境界は不変**: middleware (src/middleware.ts) が全 server request で tokenVersion を検証、
 *     layout (src/lib/page-auth.ts: requireAuthForLayout) も DB 照合する。クライアント側 session が「古い」
 *     状態でも、API/route ガードは server で必ず行われるため越境リスクなし。
 *   - **明示的な update() は引き続き動作**: settings-client.tsx でテーマ変更時に `updateSession()` 呼出 →
 *     `router.refresh()` で SSR 再描画する経路は refetch 設定とは独立、影響なし。
 *   - **マルチタブで他方ログアウト未検知**: 旧挙動でも focus 復帰時に最大数秒の遅延あり、実害微小。
 *     どうしても必要なら window focus 時に明示 `update()` する追加実装で代替可。
 *
 *   関連: docs/archive/performance/20260601/investigation-and-fixes-2026-06-01.md §5.6 (追加調査-E)
 */

import { SessionProvider } from 'next-auth/react';
import type { Session } from 'next-auth';

type Props = {
  children: React.ReactNode;
  /** PR #119: 初期 session 値。root layout の await auth() で取得したものを渡す。 */
  session: Session | null;
};

export function AppSessionProvider({ children, session }: Props) {
  return (
    <SessionProvider
      session={session}
      refetchInterval={0}
      refetchOnWindowFocus={false}
    >
      {children}
    </SessionProvider>
  );
}

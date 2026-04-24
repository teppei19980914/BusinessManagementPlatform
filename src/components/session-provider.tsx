'use client';

/**
 * Client Component ラッパー (PR #67 / PR #119 拡張): NextAuth v5 の SessionProvider を
 * root layout から使えるように client 境界に切り出す。
 *
 * PR #119: `session` prop を受け取り、SessionProvider の初期値として渡すようにした。
 *   これにより `useSession()` の第 1 レンダリングで session が確定しており、
 *   i18n 描画 (useFormatters 経由で timezone/locale を解決) がハイドレーション安全になる。
 *   (従来は undefined → mount 後 fetch → 再描画で値確定、の経路だった。)
 */

import { SessionProvider } from 'next-auth/react';
import type { Session } from 'next-auth';

type Props = {
  children: React.ReactNode;
  /** PR #119: 初期 session 値。root layout の await auth() で取得したものを渡す。 */
  session: Session | null;
};

export function AppSessionProvider({ children, session }: Props) {
  return <SessionProvider session={session}>{children}</SessionProvider>;
}

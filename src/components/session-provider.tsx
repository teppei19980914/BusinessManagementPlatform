'use client';

/**
 * Client Component ラッパー (PR #67): NextAuth v5 の SessionProvider を
 * root layout から使えるように client 境界に切り出す。
 *
 * 既存コードは useSession を使っていなかったが、MFA 検証ページで
 * セッションの update を呼ぶ必要があるため、全ページ共通で利用可能にする。
 */

import { SessionProvider } from 'next-auth/react';

export function AppSessionProvider({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}

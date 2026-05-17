/**
 * (public) route group layout — 未認証ユーザがアクセス可能なページ群
 *
 * 含まれるルート:
 *   /terms   — 利用規約 (ドラフト、法務監修待ち)
 *   /privacy — プライバシーポリシー (ドラフト、法務監修待ち)
 *
 * Middleware の PUBLIC_PATHS との整合に注意。
 * /terms, /privacy を未認証アクセス可能にするため、 src/middleware.ts の
 * PUBLIC_PATHS 配列に追加すること (本 PR で同時対応)。
 */

import type { ReactNode } from 'react';

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto max-w-3xl px-4 py-12">{children}</main>
      <footer className="mx-auto max-w-3xl border-t px-4 py-6 text-center text-xs text-muted-foreground">
        <a href="/terms" className="mx-2 hover:underline">
          利用規約
        </a>
        <a href="/privacy" className="mx-2 hover:underline">
          プライバシーポリシー
        </a>
        <a href="/login" className="mx-2 hover:underline">
          ログイン
        </a>
      </footer>
    </div>
  );
}

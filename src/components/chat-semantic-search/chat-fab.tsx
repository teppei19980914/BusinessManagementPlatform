'use client';

/**
 * チャット意味検索のフローティングボタン (FAB) + パネル統合 Client Component。
 *
 * 仕様: docs/specification/CHAT_SEMANTIC_SEARCH.md §3.1 / §6
 *   - 全ページ右下に常時表示 (DashboardLayout 内に配置 = 認証済ユーザのみ)
 *   - クリック → ChatPanel をオーバーレイ展開
 *   - z-40 でメインコンテンツより上、Toast (z-50) より下に配置
 */

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { ChatPanel } from './chat-panel';

export function ChatSemanticSearchFab() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="過去資産を意味検索"
          className={cn(
            'fixed right-4 bottom-4 z-40 flex h-12 w-12 items-center justify-center',
            'rounded-full bg-primary text-primary-foreground shadow-lg',
            'hover:bg-primary/80 focus:outline-none focus:ring-2 focus:ring-ring',
          )}
        >
          <span className="text-xl" aria-hidden="true">💬</span>
        </button>
      )}
      {open && <ChatPanel onClose={() => setOpen(false)} />}
    </>
  );
}

'use client';

/**
 * チャット意味検索のフローティングボタン (FAB) + パネル統合 Client Component。
 *
 * 仕様: docs/specification/CHAT_SEMANTIC_SEARCH.md §3.1 / §6
 *   - 全ページ右下に常時表示 (DashboardLayout 内に配置 = 認証済ユーザのみ)
 *   - クリック → ChatPanel をオーバーレイ展開
 *   - z-40 でメインコンテンツより上、Toast (z-50) より下に配置
 *
 * 2026-05-27 デザイン更新:
 *   - 旧: 絵文字バブル単独を bg-primary 円形ボタンに乗せた質素な実装
 *   - 新: マスコット「たすきフクロウ」(吹き出し + たすき帯 + 盾) のアイコン画像で
 *         「フクロウに相談する」体験を演出。画像自体が円形デザインのため bg は不要、
 *         hover/focus の ring のみで対話性を担保。
 */

import { useState } from 'react';
import Image from 'next/image';
import { cn } from '@/lib/utils';
import { CHAT_PERSONA } from '@/config';
import { ChatPanel } from './chat-panel';

export function ChatSemanticSearchFab() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`${CHAT_PERSONA.name}に相談する`}
          data-testid="chat-fab"
          className={cn(
            'fixed right-4 bottom-4 z-40 flex h-14 w-14 items-center justify-center',
            'rounded-full bg-background shadow-lg ring-1 ring-border',
            'transition-transform hover:scale-105',
            'focus:outline-none focus:ring-2 focus:ring-ring',
          )}
        >
          <Image
            src={CHAT_PERSONA.avatarSrc}
            alt={CHAT_PERSONA.avatarAlt}
            width={56}
            height={56}
            priority
            className="rounded-full"
          />
        </button>
      )}
      {open && <ChatPanel onClose={() => setOpen(false)} />}
    </>
  );
}

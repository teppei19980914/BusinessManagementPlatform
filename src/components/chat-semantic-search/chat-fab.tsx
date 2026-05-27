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
 *   - 新: マスコット「たすきフクロウ」(吹き出し + たすき帯 + 盾) のアイコン画像を
 *         **FAB 全面に占有させる** デザイン。派生画像自体がバッジで全面を埋めるよう
 *         scripts/generate-mascot-derivatives.cjs で trim 抽出済 (KDD §5.X+165)。
 *         そのため button 側に bg / ring は不要 (絵の外周がそのまま FAB の輪郭になる)。
 *   - motion-reduce 対応: hover scale を accessibility ユーザ向けに無効化
 *     (KDD §5.X+165 の付随 a11y 対策)。
 */

import { useState } from 'react';
import Image from 'next/image';
import { cn } from '@/lib/utils';
import { CHAT_PERSONA } from '@/config';
import { ChatPanel } from './chat-panel';

const FAB_SIZE_PX = 64;

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
            'fixed right-4 bottom-4 z-40 h-16 w-16 overflow-hidden rounded-full shadow-lg',
            'transition-transform motion-reduce:transition-none',
            'hover:scale-105 motion-reduce:hover:scale-100',
            'focus:outline-none focus:ring-2 focus:ring-ring',
          )}
        >
          <Image
            src={CHAT_PERSONA.avatarSrc}
            alt={CHAT_PERSONA.avatarAlt}
            width={FAB_SIZE_PX}
            height={FAB_SIZE_PX}
            priority
            className="h-full w-full object-cover"
          />
        </button>
      )}
      {open && <ChatPanel onClose={() => setOpen(false)} />}
    </>
  );
}

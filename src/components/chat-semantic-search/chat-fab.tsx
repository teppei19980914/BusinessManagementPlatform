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

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { cn } from '@/lib/utils';
import { CHAT_PERSONA } from '@/config';
import { OPEN_HELP_CHAT_EVENT } from '@/lib/open-help-chat';
import { ChatPanel } from './chat-panel';

const FAB_SIZE_PX = 64;

export function ChatSemanticSearchFab() {
  const [open, setOpen] = useState(false);

  // G2-e-3 (2026-05-31): オンボーディングモーダル等から「ヘルプ・ガイド」タブで
  //   チャットを開く要求 (requestOpenHelpChat) を購読する。mode は sessionStorage 経由で
  //   ChatPanel が 'help' を復元するため、ここでは open するだけでよい。
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(OPEN_HELP_CHAT_EVENT, handler);
    return () => window.removeEventListener(OPEN_HELP_CHAT_EVENT, handler);
  }, []);

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`${CHAT_PERSONA.name}に相談する`}
          data-testid="chat-fab"
          /*
            iOS safe-area: home indicator (portrait で 34px、landscape で 21px) と
            FAB が重ならないよう、`bottom-4` (16px) に `env(safe-area-inset-bottom)` を
            足す。WebView や PWA で `viewport-fit=cover` 指定時のみ非ゼロ値を返し、
            通常ブラウザでは 0 のため既存挙動と互換 (KDD §5.X+166)。
          */
          className={cn(
            'fixed right-4 z-40 h-16 w-16 overflow-hidden rounded-full',
            'bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)]',
            'shadow-lg dark:shadow-black/50',
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
            // perf/comprehensive-perf-2026-06-01 (A-3): sizes で srcset 1 ブレークポイント固定。
            //   FAB は fixed-width 描画なので 1 解像度で十分。priority + sizes で preload 1 リクエストに揃える。
            sizes="64px"
            className="h-full w-full object-cover"
          />
        </button>
      )}
      {open && <ChatPanel onClose={() => setOpen(false)} />}
    </>
  );
}

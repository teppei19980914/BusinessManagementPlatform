'use client';

/**
 * ClickableRow / ClickableCard (Phase E 要件 1〜3 / 共通部品化, 2026-04-29):
 *
 * 「行/カード全体をクリックで dialog を開く」UX を共通化。
 * `cursor-pointer hover:bg-muted` の className が 17 箇所で重複していたため、
 * 単一の真実 (single source of truth) として抽出。今後 hover 色や transition 等の
 * 仕様を変更するときに修正箇所を 1 つに絞る目的。
 *
 * 使い分け:
 *   - `<ClickableRow>` : 一覧テーブル (`<Table>` 内の `<TableRow>` 置換)
 *   - `<ClickableCard>`: カードレイアウト (rounded border 構造の `<div>` 置換)
 *   - `CLICKABLE_HOVER_CLASS`: 上記で扱えない複雑な構造で混ぜ込みたい場合の className 定数
 *
 * 振る舞い:
 *   - `active=false` (既定 true) の場合は cursor も hover も無効化し、onClick も呼ばない。
 *     例: memos-client が `m.isMine ? clickable : non-clickable` と分岐していたパターンを
 *     `<ClickableRow active={m.isMine} onClick={...}>` で表現する。
 *   - className 追加は受け取って末尾結合 (cn 既定の重複排除に依存)。
 */

import { cn } from '@/lib/utils';
import { TableRow } from '@/components/ui/table';

/** className 単独利用版 (複雑なレイアウトに混ぜ込む場合) */
export const CLICKABLE_HOVER_CLASS = 'cursor-pointer hover:bg-muted';
/** カード版: padding が大きく hover の不透明度を下げたいレイアウト用 */
export const CLICKABLE_HOVER_CARD_CLASS = 'cursor-pointer hover:bg-muted/50 transition-colors';

type ClickableRowProps = {
  onClick?: () => void;
  /** クリック可否。false の場合は cursor も hover もつかず onClick も呼ばない (権限分岐) */
  active?: boolean;
  className?: string;
  children: React.ReactNode;
};

export function ClickableRow({ onClick, active = true, className, children }: ClickableRowProps) {
  return (
    <TableRow
      onClick={active ? onClick : undefined}
      className={cn(active && CLICKABLE_HOVER_CLASS, className)}
    >
      {children}
    </TableRow>
  );
}

type ClickableCardProps = {
  onClick?: () => void;
  active?: boolean;
  /**
   * 既定 false: 一覧の小さめカード (project-knowledge 等) で hover:bg-muted (不透明 100%)。
   * true: 大きめカード (retrospectives / project-detail) で hover:bg-muted/50 + transition (落ち着いた表現)。
   */
  subtle?: boolean;
  /** ネイティブ tooltip (project-detail の「クリックで編集」hint 等で使用) */
  title?: string;
  className?: string;
  children: React.ReactNode;
};

/**
 * カード型のクリッカブル領域。`<div>` 直書きに比べて hover 表現を統一できる。
 * 元 className に padding (p-3 / p-4 / p-6) や border/rounded を含めて呼出側で指定する
 * (カードの大きさ・余白はレイアウトごとに異なるため注入しない)。
 *
 * `subtle` で 2 段階の hover 強度を切替: 既定は CLICKABLE_HOVER_CLASS (TableRow と同じ)、
 * `subtle` 時は CLICKABLE_HOVER_CARD_CLASS (transition + 半透明) で控えめに。
 */
export function ClickableCard({
  onClick,
  active = true,
  subtle = false,
  title,
  className,
  children,
}: ClickableCardProps) {
  const hover = subtle ? CLICKABLE_HOVER_CARD_CLASS : CLICKABLE_HOVER_CLASS;
  return (
    <div
      onClick={active ? onClick : undefined}
      title={active ? title : undefined}
      className={cn(active && hover, className)}
    >
      {children}
    </div>
  );
}

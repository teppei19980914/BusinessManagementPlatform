'use client';

/**
 * BulkSelectHeader / BulkSelectCell (Phase E 要件 1〜3 / 共通部品化, 2026-04-29):
 *
 * 「○○一覧」の一括編集 checkbox 列を共通化。
 * 現状 4 画面 (memos / project-knowledge / retrospectives / risks) で同じ shape の
 * checkbox がコピペされていたため抽出。
 *
 * 使い分け:
 *   - `<BulkSelectHeader>`: ヘッダ行の「全選択」checkbox。
 *     allSelected と totalSelectable から自動で disabled 判定する。
 *   - `<BulkSelectCell>`: 各行の checkbox。`canSelect=false` の行 (= 他人が起票/作成した行)
 *     は checkbox の代わりに "-" placeholder を表示する。
 *
 * 認可: クライアント側の表示制御に過ぎない。サーバ側で per-row 認可 (silent skip) が必須
 *       (DEVELOPER_GUIDE §5.37 参照)。
 */

type HeaderProps = {
  allSelected: boolean;
  /** 選択可能件数 (ゼロなら disabled) */
  totalSelectable: number;
  onToggleAll: () => void;
  ariaLabel: string;
};

export function BulkSelectHeader({
  allSelected,
  totalSelectable,
  onToggleAll,
  ariaLabel,
}: HeaderProps) {
  return (
    <input
      type="checkbox"
      aria-label={ariaLabel}
      checked={allSelected}
      disabled={totalSelectable === 0}
      onChange={onToggleAll}
      className="rounded"
    />
  );
}

type CellProps = {
  /** この行が選択可能か (作成者本人か等)。false の場合は placeholder 表示 / 何も描画しない */
  canSelect: boolean;
  selected: boolean;
  onToggle: () => void;
  ariaLabel: string;
  /** canSelect=false 時のプレースホルダ tooltip (例: "他人作成の行は編集不可") */
  notSelectableTitle?: string;
  /** canSelect=false 時に "-" を出さず null を返す (card レイアウト用)。既定 false。 */
  hidePlaceholderWhenDisabled?: boolean;
  /**
   * 親 (行/カード) の onClick を発火させたくない時に true (TableCell でラップしない card 用途)。
   * onChange / onClick の両方で stopPropagation する。
   */
  stopPropagation?: boolean;
};

export function BulkSelectCell({
  canSelect,
  selected,
  onToggle,
  ariaLabel,
  notSelectableTitle,
  hidePlaceholderWhenDisabled = false,
  stopPropagation = false,
}: CellProps) {
  if (!canSelect) {
    if (hidePlaceholderWhenDisabled) return null;
    return (
      <span className="text-xs text-muted-foreground" title={notSelectableTitle}>
        -
      </span>
    );
  }
  return (
    <input
      type="checkbox"
      aria-label={ariaLabel}
      checked={selected}
      onChange={(e) => {
        if (stopPropagation) e.stopPropagation();
        onToggle();
      }}
      onClick={stopPropagation ? (e) => e.stopPropagation() : undefined}
      className="rounded"
    />
  );
}

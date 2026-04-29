'use client';

/**
 * ResponsiveTable — md: 以上でテーブル / 未満でカードに自動切替する一覧コンポーネント (PR #128)。
 *
 * 設計方針:
 *   - **PC UX は現行 `<Table>` と同一** (md: 以上では table タグをそのままレンダ)
 *   - **スマホ (〜767px) ではカード形式に変換** して縦並びで表示 (横スクロール回避)
 *   - データ / ハンドラ / 列定義は 1 つの props で受け取り、2 種類の DOM を切替表示
 *   - Tailwind レスポンシブ (`hidden md:block` / `md:hidden`) のみで切替、JS 判定なし
 *     → SSR でも両 DOM が出力されるが、CSS で一方のみ表示
 *     → CLS (Cumulative Layout Shift) が最小化、mount 時のチラつきも無い
 *
 * 使い方:
 *   <ResponsiveTable
 *     items={risks}
 *     getRowKey={(r) => r.id}
 *     onRowClick={(r) => openDialog(r)}
 *     columns={[
 *       { key: 'title', label: '件名', primary: true, render: (r) => r.title },
 *       { key: 'assignee', label: '担当者', render: (r) => r.assigneeName },
 *       { key: 'status', label: 'ステータス', render: (r) => <Badge>{r.status}</Badge> },
 *     ]}
 *     emptyText="データがありません"
 *   />
 *
 * PC (md: 以上) のレンダ:
 *   <table> → 列ヘッダ行 + 各行 + クリック可
 *
 * モバイル (md: 未満) のレンダ:
 *   各 item が <div class="card"> としてレンダ:
 *     primary 列を大きく表示 (タイトル)、他列は「ラベル: 値」形式の小さなリスト
 *
 * アクセシビリティ:
 *   - テーブルモード: 標準の <table> 構造で semantic OK
 *   - カードモード: role="list" / role="listitem" + aria-label で支援技術対応
 *
 * セキュリティ:
 *   - column.render が返す React ノードは通常通り React が自動エスケープ
 *   - column.key はコンポーネント消費側で固定値 (ユーザ入力を混ぜない設計)
 */

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
// Phase E (2026-04-29): hover 表現を共通定数で統一 (cursor-pointer hover:bg-muted)
import { CLICKABLE_HOVER_CLASS } from '@/components/common/clickable-row';

export type ResponsiveTableColumn<T> = {
  /** 列の識別子 (React key 用、consumer 側で固定文字列) */
  key: string;
  /** ヘッダ / カードラベル */
  label: string;
  /** true のときカードモードでタイトル行として大きく表示 (通常 1 列のみ true 推奨) */
  primary?: boolean;
  /** セル描画関数。React ノードを返す (文字列 / JSX どちらも可) */
  render: (item: T) => React.ReactNode;
  /** テーブルモードのみ適用する追加クラス (whitespace-nowrap 等) */
  className?: string;
  /**
   * カードモードでこの列を非表示にする (詳細列を一覧カードで省く用途)。
   * テーブルモードでは常に表示される。
   */
  hiddenOnCard?: boolean;
};

export type ResponsiveTableProps<T> = {
  items: readonly T[];
  columns: ReadonlyArray<ResponsiveTableColumn<T>>;
  /** React key 抽出。id がある場合は `(item) => item.id` など */
  getRowKey: (item: T) => string;
  /** 行クリックハンドラ (カードモードでも同じハンドラ) */
  onRowClick?: (item: T) => void;
  /** 空時の表示テキスト */
  emptyText?: string;
  /** テーブル全体の追加クラス */
  className?: string;
  /** aria-label for the list / table */
  'aria-label'?: string;
};

export function ResponsiveTable<T>({
  items,
  columns,
  getRowKey,
  onRowClick,
  emptyText,
  className,
  'aria-label': ariaLabel,
}: ResponsiveTableProps<T>) {
  const tMessage = useTranslations('message');
  const resolvedEmptyText = emptyText ?? tMessage('noData');
  const clickable = !!onRowClick;
  const cardColumns = columns.filter((c) => !c.hiddenOnCard);
  const primaryCol = cardColumns.find((c) => c.primary);
  const secondaryCols = cardColumns.filter((c) => !c.primary);

  return (
    <>
      {/* PC (md:+): 従来のテーブル形式、UX 変更なし */}
      <div className={cn('hidden md:block', className)}>
        <table className="w-full caption-bottom text-sm" aria-label={ariaLabel}>
          <thead className="border-b">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    'h-10 px-2 text-left align-middle font-medium text-muted-foreground',
                    col.className,
                  )}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="py-8 text-center text-muted-foreground"
                >
                  {resolvedEmptyText}
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr
                  key={getRowKey(item)}
                  className={cn(
                    'border-b transition-colors',
                    clickable && CLICKABLE_HOVER_CLASS,
                  )}
                  onClick={clickable ? () => onRowClick!(item) : undefined}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn('p-2 align-middle', col.className)}
                    >
                      {col.render(item)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* モバイル (md: 未満): カード形式、縦並び */}
      <div
        className={cn('md:hidden', className)}
        role="list"
        aria-label={ariaLabel}
      >
        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{resolvedEmptyText}</p>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <div
                key={getRowKey(item)}
                role="listitem"
                className={cn(
                  'rounded-md border bg-card p-3 text-sm transition-colors',
                  clickable && 'cursor-pointer hover:bg-muted',
                )}
                onClick={clickable ? () => onRowClick!(item) : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onRowClick!(item);
                        }
                      }
                    : undefined
                }
                tabIndex={clickable ? 0 : undefined}
              >
                {primaryCol && (
                  <div className="mb-2 font-medium">{primaryCol.render(item)}</div>
                )}
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  {secondaryCols.map((col) => (
                    <React.Fragment key={col.key}>
                      <dt className="text-xs text-muted-foreground">{col.label}</dt>
                      <dd className="text-sm text-foreground">{col.render(item)}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

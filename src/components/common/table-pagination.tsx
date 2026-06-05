'use client';

/**
 * 一覧テーブル共通のクライアント側ページネーション (2026-06-03)。
 *
 * 全一覧画面 (プロジェクト一覧 / 全○○ / ○○一覧 / メモ / ユーザ管理 / 監査ログ等) で
 * 共通利用する標準部品。1 ページ TABLE_PAGE_SIZE 行ずつ描画し、全件取得しても DOM は
 * 1 ページ分のみに保つ (描画コストを取得件数に依存させない)。
 *
 * 使い方:
 *   const { pageItems, page, pageCount, setPage } = useTablePagination(sorted, resetKey);
 *   // sorted の代わりに pageItems を .map で描画
 *   // 表の直下に <TablePagination page={page} pageCount={pageCount} onPageChange={setPage} /> を配置
 *
 * resetKey:
 *   絞り込み / 検索条件をまとめた文字列等を渡す。値が変わると先頭ページに戻る
 *   (絞り込み変更時にページ位置が取り残されるのを防ぐ)。絞り込みが無い一覧は定数 '' でよい
 *   (件数が減ったケースは currentPage のクランプで吸収する)。
 *
 * UI 位置:
 *   TablePagination は常に「表の直下・中央」に配置し、全画面で統一する。
 *   ページが 1 つだけ (pageCount <= 1) のときは何も描画しない。
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

/** 1 ページあたりの行数 (全一覧共通) */
export const TABLE_PAGE_SIZE = 100;

export function useTablePagination<T>(
  // multiSort 等は readonly T[] を返すため readonly を受け取れるようにする
  // (slice の戻りは mutable T[] のため pageItems の利用側に影響はない)。
  items: readonly T[],
  resetKey: unknown,
  pageSize: number = TABLE_PAGE_SIZE,
): { pageItems: T[]; page: number; pageCount: number; setPage: (p: number) => void } {
  const [page, setPage] = useState(0);
  // resetKey が変わったら先頭ページへ (render 中に同期リセット = ちらつき無し)。
  const [prevKey, setPrevKey] = useState(resetKey);
  if (prevKey !== resetKey) {
    setPrevKey(resetKey);
    setPage(0);
  }
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageItems = items.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  return { pageItems, page: currentPage, pageCount, setPage };
}

export function TablePagination({
  page,
  pageCount,
  onPageChange,
}: {
  /** 現在ページ (0 始まり) */
  page: number;
  pageCount: number;
  onPageChange: (p: number) => void;
}) {
  const t = useTranslations('common.pagination');
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-3 text-sm">
      <Button variant="outline" size="sm" disabled={page === 0} onClick={() => onPageChange(page - 1)}>
        {t('prev')}
      </Button>
      <span className="text-muted-foreground">
        {t('indicator', { current: page + 1, total: pageCount })}
      </span>
      <Button variant="outline" size="sm" disabled={page >= pageCount - 1} onClick={() => onPageChange(page + 1)}>
        {t('next')}
      </Button>
    </div>
  );
}

'use client';

/**
 * useAutoOpenDialog (PR feat/notification-edit-dialog / 2026-05-01)。
 *
 * 「全○○」一覧画面で `?xxxId=<UUID>` クエリパラメータを読み取り、該当行の
 * 編集 dialog を自動 open するための共通フック。通知クリック (mention 通知の
 * deep link) の着地点として使われる。
 *
 * 仕様:
 *   1. mount 時に query string から指定キーの値を取得
 *   2. items 配列から該当 id を探し、見つかれば onOpen(item) を呼ぶ
 *   3. 開いた後は URL から query を削除 (履歴を汚さない、戻るボタンで再 open しない)
 *   4. items が空 (= 初期ロード未完) の間はリトライしない (1 回のみの試行)
 *
 * 使い方:
 *   useAutoOpenDialog({
 *     queryKey: 'riskId',
 *     items: filteredRisks,
 *     onOpen: (risk) => handleRowClick(risk),
 *   });
 *
 * 注意:
 *   - items が非同期に増える設計 (pagination 等) の場合は本フック対象外。
 *     全○○ は MVP では一括 fetch なので問題なし。
 *   - filter / sort で見えない行も対象 (filtered ではなく allItems を渡す側もあり)。
 *     呼出側で適切に判断する。
 */

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';

type Props<T> = {
  /** クエリパラメータ名 (e.g. 'riskId', 'retroId', 'knowledgeId') */
  queryKey: string;
  /** 探索対象の配列 (id プロパティ必須) */
  items: readonly { id: string }[] | null | undefined;
  /** 該当行が見つかったときに呼ばれる callback (dialog open 等) */
  onOpen: (item: T) => void;
};

export function useAutoOpenDialog<T extends { id: string }>({
  queryKey,
  items,
  onOpen,
}: Props<T>): void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const triggeredRef = useRef(false);

  useEffect(() => {
    if (triggeredRef.current) return;
    if (!items || items.length === 0) return;
    const targetId = searchParams.get(queryKey);
    if (!targetId) return;

    const found = items.find((it) => it.id === targetId);
    if (!found) {
      // 該当 entity が見つからない (削除済 or 非公開) ケース。query は消して
      // 履歴を汚さないが、特にエラー UI は出さない (一覧として閲覧継続できる)。
      triggeredRef.current = true;
      cleanUrl();
      return;
    }

    triggeredRef.current = true;
    onOpen(found as T);
    cleanUrl();

    function cleanUrl(): void {
      const next = new URLSearchParams(searchParams);
      next.delete(queryKey);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
    // onOpen は呼出側で memo 化されていない可能性があるが、triggeredRef で 1 度きり
    // 実行を担保しているため deps に含めなくて安全。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, queryKey, searchParams, pathname, router]);
}

'use client';

/**
 * useAutoOpenDialog (PR feat/notification-edit-dialog / 2026-05-01,
 * fix/chat-search-and-auto-open / 2026-05-24)。
 *
 * 「全○○」一覧画面で `?xxxId=<UUID>` クエリパラメータを読み取り、該当行の
 * 編集 dialog を自動 open するための共通フック。通知クリック (mention 通知の
 * deep link) およびチャット意味検索の結果カードクリックの着地点として使われる。
 *
 * 仕様:
 *   1. mount 時 + searchParams 変化時に query string から指定キーの値を取得
 *   2. items 配列から該当 id を探し、見つかれば onOpen(item) を呼ぶ
 *   3. 開いた後は URL から query を削除 (履歴を汚さない、戻るボタンで再 open しない)
 *   4. items が空 (= 初期ロード未完) の間はリトライしない
 *   5. 同一マウント内で 2 回目以降の auto-open に対応 (チャット検索の連続クリック等)
 *
 * 使い方:
 *   useAutoOpenDialog({
 *     queryKey: 'riskId',
 *     items: filteredRisks,
 *     onOpen: (risk) => handleRowClick(risk),
 *   });
 *
 * 重複発火防止の仕組み (fix/chat-search-and-auto-open):
 *   旧実装は `triggeredRef: boolean` で 1 度きりに固定していたため、同一画面で
 *   別 id の `?xxxId=...` に遷移しても 2 回目以降が発火しない罠があった
 *   (例: チャットから /knowledge?knowledgeId=A を開いた後、続けて B を開けない)。
 *   現実装は `lastTriggeredIdRef: string | null` に変更し、
 *     - 同じ id への重複発火は引き続き抑止 (cleanUrl との競合回避)
 *     - 異なる id が来たら再発火
 *     - targetId が null (URL クリーン後) のタイミングで ref を reset
 *   とすることで、同一画面再訪時にも正しく動くようにした。
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
  // 直近で auto-open を発火した id を記録。同 id への連続発火を抑止しつつ、
  // 別 id への遷移時には改めて発火させるために boolean ではなく id を保持する。
  const lastTriggeredIdRef = useRef<string | null>(null);

  useEffect(() => {
    const targetId = searchParams.get(queryKey);
    if (!targetId) {
      // URL がクリーンになったタイミングで ref を reset。
      // これにより以後同一 id が再度指定されても発火可能になる
      // (例: チャットから A→B→A と連続クリックする操作)。
      lastTriggeredIdRef.current = null;
      return;
    }
    if (lastTriggeredIdRef.current === targetId) return;
    if (!items || items.length === 0) return;

    const found = items.find((it) => it.id === targetId);
    // found / not-found に関わらず、当該 targetId について本マウントでは
    // 再判定不要なので ref を先に更新 (cleanUrl 反映までのレース回避)。
    lastTriggeredIdRef.current = targetId;
    if (found) {
      onOpen(found as T);
    }
    // 該当 entity が見つからない (削除済 or 非公開) 場合も、query は消して
    // 履歴を汚さないが、特にエラー UI は出さない (一覧として閲覧継続できる)。
    cleanUrl();

    function cleanUrl(): void {
      const next = new URLSearchParams(searchParams);
      next.delete(queryKey);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
    // onOpen は呼出側で memo 化されていない可能性があるが、lastTriggeredIdRef で
    // 同 id の重複発火を抑止しているため deps に含めなくて安全。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, queryKey, searchParams, pathname, router]);
}

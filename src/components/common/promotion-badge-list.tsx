'use client';

/**
 * PromotionBadgeList (v1.3.0 資産導線機能):
 *
 *   昇華リンク (リスク→課題 / 課題→ナレッジ) の「昇華済み」「昇華元」を双方向に表示する
 *   読み取り専用バッジセクション。GET /api/promotions を queryParams で叩くだけの薄い
 *   コンポーネントで、4 つの呼び出しパターン (promotedIssues/sourceRisks/promotedKnowledge/
 *   sourceIssues) を呼出元 (risk-edit-dialog / knowledge-edit-dialog) から queryParams で
 *   切り替える。
 *
 *   昇華は M:N かつ再昇華の system 側ブロックがない (ユーザ要件)。本セクションは
 *   「過去に昇華した/された記録がある」ことを示すだけで、操作 (解除等) は提供しない。
 *
 *   手動リンク (asset-link-section.tsx) とは視覚的に区別するため warning 系の配色を使う
 *   (manual link は info 系)。詳細画面間の直接遷移リンクは存在しない (dialog ベースの
 *   detail UI には deep-link 規約が無いため、プレーンな chip 表示のみ)。
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

type PromotedAsset = {
  id: string;
  title: string;
  visibility: string;
  promotedAt: string;
};

type Props = {
  /** 'promotion' namespace 内のタイトルキー (例: 'promotedIssuesTitle')。{count} プレースホルダを内包する。 */
  titleKey: string;
  /** GET /api/promotions のクエリ文字列 (例: `fromType=risk&fromId=${riskId}`) */
  queryParams: string;
};

export function PromotionBadgeList({ titleKey, queryParams }: Props) {
  const tPromotion = useTranslations('promotion');
  const [items, setItems] = useState<PromotedAsset[] | null>(null);

  // queryParams 変更時にサーバから同期取得する。外部 API 同期のため
  // react-hooks/set-state-in-effect 例外規定の対象 (comment-section.tsx と同様)。
  useEffect(() => {
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setItems(null);
    fetch(`/api/promotions?${queryParams}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { data?: PromotedAsset[] } | null) => {
        if (active) setItems(json?.data ?? []);
      })
      .catch(() => {
        if (active) setItems([]);
      });
    return () => {
      active = false;
    };
  }, [queryParams]);

  // 昇華記録が無い場合はセクション自体を表示しない (バッジ的な存在感のため空状態は出さない)
  if (!items || items.length === 0) return null;

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{tPromotion(titleKey, { count: items.length })}</h3>
      <ul className="flex flex-wrap gap-2">
        {items.map((item) => (
          <li
            key={item.id}
            className="max-w-full overflow-hidden rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 text-xs"
            title={item.title}
          >
            <span className="truncate">{item.title}</span>
            {item.visibility !== 'public' && (
              <span className="text-muted-foreground">{tPromotion('nonPublicSuffix')}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

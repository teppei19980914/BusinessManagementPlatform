'use client';

/**
 * SuggestionsPanel (PR #65 核心機能 + PR-X6 段階表示):
 *   プロジェクトに対するナレッジ / 過去課題 / 過去振り返りの提案リストを
 *   3 段階 (強く関連 / 関連の可能性 / 弱い関連性) で表示し、採用操作を行う。
 *
 *   PR-X6 (2026-05-07) で段階表示 (Tiered Display) を導入。
 *   - 強く関連: 最初から表示、目立つ装飾
 *   - 関連の可能性: 通常表示
 *   - 弱い関連性: 折りたたみデフォルト (clicker で展開可能、情報過多回避)
 *
 *   「参考」タブ内と「新規作成後の提案モーダル」で共用する (DRY)。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
import { KNOWLEDGE_TYPES } from '@/types';

type SuggestionTier = 'strong' | 'medium' | 'weak';

type ScoreFields = {
  score: number;
  tagScore: number;
  textScore: number;
  tier: SuggestionTier;
};

type KnowledgeSuggestion = ScoreFields & {
  kind: 'knowledge';
  id: string;
  title: string;
  knowledgeType: string;
  snippet: string;
};

type PastIssueSuggestion = ScoreFields & {
  kind: 'issue';
  id: string;
  title: string;
  snippet: string;
  sourceProjectId: string;
  sourceProjectName: string | null;
};

type RetrospectiveSuggestion = ScoreFields & {
  kind: 'retrospective';
  id: string;
  conductedDate: string;
  snippet: string;
  sourceProjectId: string;
  sourceProjectName: string | null;
};

type SuggestionsResult = {
  knowledge: KnowledgeSuggestion[];
  pastIssues: PastIssueSuggestion[];
  retrospectives: RetrospectiveSuggestion[];
};

type PanelState = { loaded: false } | { loaded: true; data: SuggestionsResult };

/**
 * tier 別にグルーピングする helper。
 * 入力は score 降順前提 (= service 側で並べ替え済)。各 tier 内も score 降順を維持。
 */
function groupByTier<T extends { tier: SuggestionTier }>(items: T[]): {
  strong: T[];
  medium: T[];
  weak: T[];
} {
  return {
    strong: items.filter((i) => i.tier === 'strong'),
    medium: items.filter((i) => i.tier === 'medium'),
    weak: items.filter((i) => i.tier === 'weak'),
  };
}

export function SuggestionsPanel({
  projectId,
  canAdopt,
  tenantPlan,
}: {
  projectId: string;
  canAdopt: boolean;
  // 2026-05-09 (#22): 「なぜ?」ボタンの可視性制御。Pro プラン限定機能。
  //   Beginner / Expert では button 非表示 + Pro へのアップグレード誘導文を出す。
  tenantPlan: string;
}) {
  // 2026-05-09 (#22): explain ('なぜ?') 機能は Pro プラン限定 (差別化の核)。
  //   サーバ側 (suggestion-explanation.service.ts) でも plan_forbidden で reject するため
  //   UI 露出はガードラインの 1 段にすぎないが、ユーザに無駄なクリックをさせない目的。
  const canExplain = tenantPlan === 'pro';
  const t = useTranslations('suggestion');
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();
  const [state, setState] = useState<PanelState>({ loaded: false });
  const [error, setError] = useState('');
  // 採用済の ID を記録し UI を「採用済」表示に切り替える (再フェッチ不要化)
  const [adopted, setAdopted] = useState<Set<string>>(new Set());
  // 各カテゴリの「弱い関連性」セクションの展開状態 (PR-X6: 折りたたみデフォルト)
  const [expandedWeak, setExpandedWeak] = useState<Set<'knowledge' | 'issue' | 'retrospective'>>(
    new Set(),
  );

  // P-3 (2026-05-08): 説明文ダイアログの state
  // - explainTarget: 開いている候補の {kind, id, title}。null = ダイアログ閉
  // - explainLoading: 取得中 (POST in flight)
  // - explainResult: 取得済の {explanation, modelName, fromCache}
  // - explainError: エラーメッセージ (i18n キー or fallback)
  type ExplainTarget = {
    kind: 'knowledge' | 'issue' | 'retrospective';
    id: string;
    title: string;
  };
  type ExplainResult = { explanation: string; modelName: string; fromCache: boolean };
  const [explainTarget, setExplainTarget] = useState<ExplainTarget | null>(null);
  const [explainLoading, setExplainLoading] = useState(false);
  const [explainResult, setExplainResult] = useState<ExplainResult | null>(null);
  const [explainError, setExplainError] = useState('');

  const scoreTooltip = useCallback(
    (s: { tagScore: number; textScore: number }): string =>
      t('scoreTooltip', {
        tagPercent: (s.tagScore * 100).toFixed(0),
        textPercent: (s.textScore * 100).toFixed(0),
      }),
    [t],
  );

  const reload = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/suggestions`);
    if (!res.ok) {
      setError(t('fetchFailed'));
      setState({ loaded: true, data: { knowledge: [], pastIssues: [], retrospectives: [] } });
      return;
    }
    const json = await res.json();
    setState({ loaded: true, data: json.data as SuggestionsResult });
    setError('');
  }, [projectId, t]);

  // 外部 API 同期 useEffect (DESIGN.md §22)。
  // setState は async function 内に閉じ込められているため、react-hooks/set-state-in-effect は
  // 直接トリガーされない (= 過去の disable directive は不要になったため P-3 で削除)。
  useEffect(() => {
    void reload();
  }, [reload]);

  async function handleAdopt(kind: 'knowledge' | 'issue', id: string) {
    setError('');
    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/suggestions/adopt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, id }),
      }),
    );
    if (!res.ok) {
      setError(t('adoptFailed'));
      showError(kind === 'knowledge' ? 'ナレッジの採用に失敗しました' : '過去課題の採用に失敗しました');
      return;
    }
    setAdopted((prev) => {
      const next = new Set(prev);
      next.add(`${kind}:${id}`);
      return next;
    });
    showSuccess(kind === 'knowledge' ? 'ナレッジを採用しました' : '過去課題を採用しました');
  }

  const toggleWeak = (category: 'knowledge' | 'issue' | 'retrospective') => {
    setExpandedWeak((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  /**
   * P-3 (2026-05-08): 「なぜ?」ボタン押下 → 説明文ダイアログを開く + 取得開始。
   * Lazy 生成 (オンデマンド) のため初回クリック時のみ LLM 課金。2 回目以降は DB キャッシュ。
   */
  async function handleExplain(target: ExplainTarget) {
    setExplainTarget(target);
    setExplainResult(null);
    setExplainError('');
    setExplainLoading(true);

    try {
      const res = await fetch(`/api/projects/${projectId}/suggestions/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateKind: target.kind, candidateId: target.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = json?.error?.code as string | undefined;
        // 課金 / rate limit 系は固有メッセージで通知 (Beginner プラン上限の文脈を残す)
        if (code === 'RATE_LIMITED') setExplainError(t('explainErrorRateLimited'));
        else if (code === 'BEGINNER_LIMIT_EXCEEDED') setExplainError(t('explainErrorBeginnerLimit'));
        else if (code === 'BUDGET_EXCEEDED') setExplainError(t('explainErrorBudgetExceeded'));
        // 2026-05-09 (#22): Pro 限定機能の defense-in-depth エラー (UI で button を
        //   非表示にしているが直叩き / state 不整合に備える)
        else if (code === 'PLAN_FORBIDDEN') setExplainError(t('explainErrorPlanForbidden'));
        else if (code === 'LLM_ERROR') setExplainError(t('explainErrorLlm'));
        else setExplainError(t('explainErrorGeneric'));
        return;
      }
      const data = json.data as { explanation: string; modelName: string; fromCache: boolean };
      setExplainResult(data);
    } catch {
      setExplainError(t('explainErrorGeneric'));
    } finally {
      setExplainLoading(false);
    }
  }

  function closeExplainDialog() {
    setExplainTarget(null);
    setExplainResult(null);
    setExplainError('');
    setExplainLoading(false);
  }

  // tier ごとにグルーピング (loaded 後、メモ化)
  const grouped = useMemo(() => {
    if (!state.loaded) return null;
    return {
      knowledge: groupByTier(state.data.knowledge),
      pastIssues: groupByTier(state.data.pastIssues),
      retrospectives: groupByTier(state.data.retrospectives),
    };
  }, [state]);

  if (!state.loaded || !grouped) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{t('calculating')}</p>;
  }

  // 1 件の提案アイテム (knowledge / issue / retrospective 共通) を render する helper
  const renderKnowledgeItem = (k: KnowledgeSuggestion) => {
    const adoptedKey = `knowledge:${k.id}`;
    const isAdopted = adopted.has(adoptedKey);
    return (
      <li key={k.id} className="rounded border p-3">
        <div className="flex items-start gap-3">
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">
                {KNOWLEDGE_TYPES[k.knowledgeType as keyof typeof KNOWLEDGE_TYPES] || k.knowledgeType}
              </Badge>
              <span className="font-medium">{k.title}</span>
              <Badge variant="outline" title={scoreTooltip(k)}>
                {t('similarityBadge', { percent: (k.score * 100).toFixed(0) })}
              </Badge>
              {/* P-3: 「なぜこのプロジェクトに関連するのか」を Lazy 生成。
                  2026-05-09 (#22): Pro プラン限定機能のため canExplain でゲート。 */}
              {canExplain && (
                <button
                  type="button"
                  className="text-xs text-info hover:underline"
                  onClick={() => handleExplain({ kind: 'knowledge', id: k.id, title: k.title })}
                >
                  {t('explainButton')}
                </button>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{k.snippet}</p>
          </div>
          <div className="shrink-0">
            {isAdopted ? (
              <Badge>{t('knowledgeAdoptedBadge')}</Badge>
            ) : canAdopt ? (
              <Button size="sm" onClick={() => handleAdopt('knowledge', k.id)}>
                {t('knowledgeAdoptButton')}
              </Button>
            ) : null}
          </div>
        </div>
      </li>
    );
  };

  const renderIssueItem = (i: PastIssueSuggestion) => {
    const adoptedKey = `issue:${i.id}`;
    const isAdopted = adopted.has(adoptedKey);
    return (
      <li key={i.id} className="rounded border p-3">
        <div className="flex items-start gap-3">
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">{i.title}</span>
              <Badge variant="outline" title={scoreTooltip(i)}>
                {t('similarityBadge', { percent: (i.score * 100).toFixed(0) })}
              </Badge>
              {i.sourceProjectName && (
                <Link
                  href={`/projects/${i.sourceProjectId}`}
                  className="text-xs text-info hover:underline"
                >
                  {t('sourceProjectLink', { name: i.sourceProjectName })}
                </Link>
              )}
              {/* P-3: 「なぜ?」ボタン (2026-05-09 / #22: Pro 限定) */}
              {canExplain && (
                <button
                  type="button"
                  className="text-xs text-info hover:underline"
                  onClick={() => handleExplain({ kind: 'issue', id: i.id, title: i.title })}
                >
                  {t('explainButton')}
                </button>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{i.snippet}</p>
          </div>
          <div className="shrink-0">
            {isAdopted ? (
              <Badge>{t('pastIssuesAdoptedBadge')}</Badge>
            ) : canAdopt ? (
              <Button size="sm" onClick={() => handleAdopt('issue', i.id)}>
                {t('pastIssuesAdoptButton')}
              </Button>
            ) : null}
          </div>
        </div>
      </li>
    );
  };

  const renderRetrospectiveItem = (r: RetrospectiveSuggestion) => (
    <li key={r.id} className="rounded border p-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{t('retrospectiveItemTitle', { date: r.conductedDate })}</span>
            <Badge variant="outline" title={scoreTooltip(r)}>
              {t('similarityBadge', { percent: (r.score * 100).toFixed(0) })}
            </Badge>
            {r.sourceProjectName && (
              <Link
                href={`/projects/${r.sourceProjectId}/retrospectives`}
                className="text-xs text-info hover:underline"
              >
                {t('sourceProjectLink', { name: r.sourceProjectName })}
              </Link>
            )}
            {/* P-3: 「なぜ?」ボタン (2026-05-09 / #22: Pro 限定) */}
            {canExplain && (
              <button
                type="button"
                className="text-xs text-info hover:underline"
                onClick={() =>
                  handleExplain({
                    kind: 'retrospective',
                    id: r.id,
                    title: t('retrospectiveItemTitle', { date: r.conductedDate }),
                  })
                }
              >
                {t('explainButton')}
              </button>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{r.snippet}</p>
        </div>
      </div>
    </li>
  );

  /**
   * tier 別の表示ブロックを共通化。
   * - strong: 緑のボーダー、最初から展開
   * - medium: 黄色のボーダー、最初から展開
   * - weak: 灰色のボーダー、折りたたみデフォルト
   */
  const renderTieredSection = <T extends { id: string; tier: SuggestionTier }>(
    category: 'knowledge' | 'issue' | 'retrospective',
    grouped: { strong: T[]; medium: T[]; weak: T[] },
    renderItem: (item: T) => React.ReactNode,
    noMatchKey: 'knowledgeNoMatch' | 'pastIssuesNoMatch' | 'retrospectivesNoMatch',
  ) => {
    const totalCount = grouped.strong.length + grouped.medium.length + grouped.weak.length;
    if (totalCount === 0) {
      return <p className="text-sm text-muted-foreground">{t(noMatchKey)}</p>;
    }
    const isWeakExpanded = expandedWeak.has(category);

    return (
      <div className="space-y-4">
        {/* 強く関連 (strong tier) */}
        {grouped.strong.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-baseline gap-2 border-l-4 border-green-600 pl-3">
              <h4 className="font-semibold text-green-700 dark:text-green-400">
                🟢 {t('tierStrongLabel', { count: grouped.strong.length })}
              </h4>
            </div>
            <p className="ml-3 text-xs text-muted-foreground">{t('tierStrongDescription')}</p>
            <ul className="ml-3 space-y-2">{grouped.strong.map(renderItem)}</ul>
          </div>
        )}

        {/* 関連の可能性 (medium tier) */}
        {grouped.medium.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-baseline gap-2 border-l-4 border-amber-600 pl-3">
              <h4 className="font-semibold text-amber-700 dark:text-amber-400">
                🟡 {t('tierMediumLabel', { count: grouped.medium.length })}
              </h4>
            </div>
            <p className="ml-3 text-xs text-muted-foreground">{t('tierMediumDescription')}</p>
            <ul className="ml-3 space-y-2">{grouped.medium.map(renderItem)}</ul>
          </div>
        )}

        {/* 弱い関連性 (weak tier) — 折りたたみデフォルト */}
        {grouped.weak.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-baseline gap-2 border-l-4 border-muted-foreground pl-3">
              <h4 className="font-semibold text-muted-foreground">
                ⚪ {t('tierWeakLabel', { count: grouped.weak.length })}
              </h4>
              <button
                type="button"
                className="text-xs text-info hover:underline"
                onClick={() => toggleWeak(category)}
              >
                {isWeakExpanded ? t('collapseWeakSection') : t('expandWeakSection')}
              </button>
            </div>
            {isWeakExpanded && (
              <>
                <p className="ml-3 text-xs text-muted-foreground">{t('tierWeakDescription')}</p>
                <ul className="ml-3 space-y-2">{grouped.weak.map(renderItem)}</ul>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  const totals = {
    knowledge: state.data.knowledge.length,
    pastIssues: state.data.pastIssues.length,
    retrospectives: state.data.retrospectives.length,
  };

  return (
    <div className="space-y-6">
      <div className="rounded-md bg-info/10 p-3 text-sm text-info">
        <strong>{t('coreFeaturePrefix')}</strong> {t('coreFeatureDescription')}
      </div>

      {error && <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}

      {/* ナレッジ提案 */}
      <section className="space-y-2">
        <h3 className="font-semibold">{t('knowledgeSectionTitle', { count: totals.knowledge })}</h3>
        {renderTieredSection(
          'knowledge',
          grouped.knowledge,
          renderKnowledgeItem,
          'knowledgeNoMatch',
        )}
      </section>

      {/* 過去課題提案 */}
      <section className="space-y-2">
        <h3 className="font-semibold">{t('pastIssuesSectionTitle', { count: totals.pastIssues })}</h3>
        <p className="text-xs text-muted-foreground">{t('pastIssuesDescription')}</p>
        {renderTieredSection('issue', grouped.pastIssues, renderIssueItem, 'pastIssuesNoMatch')}
      </section>

      {/* 過去振り返り */}
      <section className="space-y-2">
        <h3 className="font-semibold">{t('retrospectivesSectionTitle', { count: totals.retrospectives })}</h3>
        <p className="text-xs text-muted-foreground">{t('retrospectivesDescription')}</p>
        {renderTieredSection(
          'retrospective',
          grouped.retrospectives,
          renderRetrospectiveItem,
          'retrospectivesNoMatch',
        )}
      </section>

      {/* P-3 (2026-05-08): 「なぜ?」説明文ダイアログ */}
      <Dialog
        open={explainTarget !== null}
        onOpenChange={(open) => {
          if (!open) closeExplainDialog();
        }}
      >
        <DialogContent className="max-w-[min(90vw,32rem)] lg:max-w-[min(70vw,40rem)]">
          <DialogHeader>
            <DialogTitle>{t('explainDialogTitle')}</DialogTitle>
            <DialogDescription>
              {explainTarget ? t('explainDialogSubject', { title: explainTarget.title }) : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {explainLoading && (
              <p className="text-sm text-muted-foreground">{t('explainLoading')}</p>
            )}
            {explainError && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {explainError}
              </div>
            )}
            {explainResult && (
              <>
                <p className="whitespace-pre-line text-sm">{explainResult.explanation}</p>
                <p className="text-xs text-muted-foreground">
                  {t('explainModelLabel', { model: explainResult.modelName })}
                  {explainResult.fromCache ? ` ・ ${t('explainCachedLabel')}` : ''}
                </p>
              </>
            )}
          </div>
          <Button variant="outline" onClick={closeExplainDialog}>
            {t('explainCloseButton')}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

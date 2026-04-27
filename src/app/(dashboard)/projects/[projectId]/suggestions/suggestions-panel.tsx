'use client';

/**
 * SuggestionsPanel (PR #65 核心機能): プロジェクトに対する
 * ナレッジ / 過去課題の提案リストを表示し、採用操作を行う共通パネル。
 *
 * 「参考」タブ内と「新規作成後の提案モーダル」で共用する (DRY)。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useLoading } from '@/components/loading-overlay';
import { KNOWLEDGE_TYPES } from '@/types';

type KnowledgeSuggestion = {
  kind: 'knowledge';
  id: string;
  title: string;
  knowledgeType: string;
  snippet: string;
  score: number;
  tagScore: number;
  textScore: number;
};

type PastIssueSuggestion = {
  kind: 'issue';
  id: string;
  title: string;
  snippet: string;
  sourceProjectId: string;
  sourceProjectName: string | null;
  score: number;
  tagScore: number;
  textScore: number;
};

// PR #65 Phase 2 (a): 過去振り返りも推薦対象。読み物として提示する (採用操作なし)。
type RetrospectiveSuggestion = {
  kind: 'retrospective';
  id: string;
  conductedDate: string;
  snippet: string;
  sourceProjectId: string;
  sourceProjectName: string | null;
  score: number;
  tagScore: number;
  textScore: number;
};

type SuggestionsResult = {
  knowledge: KnowledgeSuggestion[];
  pastIssues: PastIssueSuggestion[];
  retrospectives: RetrospectiveSuggestion[];
};

type PanelState =
  | { loaded: false }
  | { loaded: true; data: SuggestionsResult };

export function SuggestionsPanel({
  projectId,
  canAdopt,
}: {
  projectId: string;
  canAdopt: boolean;
}) {
  const t = useTranslations('suggestion');
  const { withLoading } = useLoading();
  const [state, setState] = useState<PanelState>({ loaded: false });
  const [error, setError] = useState('');
  // 採用済の ID を記録し UI を「採用済」表示に切り替える (再フェッチ不要化)
  const [adopted, setAdopted] = useState<Set<string>>(new Set());

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

  // 外部 API 同期のため react-hooks/set-state-in-effect の例外に該当 (DESIGN.md §22)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
      return;
    }
    setAdopted((prev) => {
      const next = new Set(prev);
      next.add(`${kind}:${id}`);
      return next;
    });
  }

  if (!state.loaded) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{t('calculating')}</p>;
  }

  const { knowledge, pastIssues, retrospectives } = state.data;

  return (
    <div className="space-y-6">
      <div className="rounded-md bg-info/10 p-3 text-sm text-info">
        <strong>{t('coreFeaturePrefix')}</strong>{' '}
        {t('coreFeatureDescription')}
      </div>

      {error && <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}

      {/* ナレッジ提案 */}
      <section className="space-y-2">
        <h3 className="font-semibold">{t('knowledgeSectionTitle', { count: knowledge.length })}</h3>
        {knowledge.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('knowledgeNoMatch')}
          </p>
        ) : (
          <ul className="space-y-2">
            {knowledge.map((k) => {
              const adoptedKey = `knowledge:${k.id}`;
              // PR #160: 自プロジェクト紐付け済みナレッジは API 側で除外されるため、
              // ここでの alreadyLinked 分岐は不要 (採用直後に表示する「紐付け済」のみ adopted で管理)
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
            })}
          </ul>
        )}
      </section>

      {/* 過去課題提案 */}
      <section className="space-y-2">
        <h3 className="font-semibold">{t('pastIssuesSectionTitle', { count: pastIssues.length })}</h3>
        <p className="text-xs text-muted-foreground">
          {t('pastIssuesDescription')}
        </p>
        {pastIssues.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('pastIssuesNoMatch')}</p>
        ) : (
          <ul className="space-y-2">
            {pastIssues.map((i) => {
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
            })}
          </ul>
        )}
      </section>

      {/*
        PR #65 Phase 2 (a): 過去振り返り (retrospective) の提示。
        problems / improvements は次プロジェクトで避けたい失敗そのもの。
        採用操作は持たず参照のみ (出典プロジェクトへのリンクで詳細を開ける)。
      */}
      <section className="space-y-2">
        <h3 className="font-semibold">{t('retrospectivesSectionTitle', { count: retrospectives.length })}</h3>
        <p className="text-xs text-muted-foreground">
          {t('retrospectivesDescription')}
        </p>
        {retrospectives.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('retrospectivesNoMatch')}</p>
        ) : (
          <ul className="space-y-2">
            {retrospectives.map((r) => (
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
                    </div>
                    <p className="text-sm text-muted-foreground">{r.snippet}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

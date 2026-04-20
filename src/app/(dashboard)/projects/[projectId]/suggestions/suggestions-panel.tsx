'use client';

/**
 * SuggestionsPanel (PR #65 核心機能): プロジェクトに対する
 * ナレッジ / 過去課題の提案リストを表示し、採用操作を行う共通パネル。
 *
 * 「参考」タブ内と「新規作成後の提案モーダル」で共用する (DRY)。
 */

import { useCallback, useEffect, useState } from 'react';
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
  alreadyLinked: boolean;
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

function scoreTooltip(s: { tagScore: number; textScore: number }): string {
  return `タグ類似度 ${(s.tagScore * 100).toFixed(0)}% / テキスト類似度 ${(s.textScore * 100).toFixed(0)}%`;
}

export function SuggestionsPanel({
  projectId,
  canAdopt,
}: {
  projectId: string;
  canAdopt: boolean;
}) {
  const { withLoading } = useLoading();
  const [state, setState] = useState<PanelState>({ loaded: false });
  const [error, setError] = useState('');
  // 採用済の ID を記録し UI を「採用済」表示に切り替える (再フェッチ不要化)
  const [adopted, setAdopted] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/suggestions`);
    if (!res.ok) {
      setError('提案の取得に失敗しました');
      setState({ loaded: true, data: { knowledge: [], pastIssues: [], retrospectives: [] } });
      return;
    }
    const json = await res.json();
    setState({ loaded: true, data: json.data as SuggestionsResult });
    setError('');
  }, [projectId]);

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
      setError('採用に失敗しました');
      return;
    }
    setAdopted((prev) => {
      const next = new Set(prev);
      next.add(`${kind}:${id}`);
      return next;
    });
  }

  if (!state.loaded) {
    return <p className="py-8 text-center text-sm text-muted-foreground">提案を計算中...</p>;
  }

  const { knowledge, pastIssues, retrospectives } = state.data;

  return (
    <div className="space-y-6">
      <div className="rounded-md bg-info/10 p-3 text-sm text-info">
        <strong>核心機能 (提案型サービス):</strong>{' '}
        このプロジェクトのタグ・目的・背景・スコープと類似する過去のナレッジ・課題を
        自動で抽出しています。可能な限り採用することで、過去の資産を活用し
        未然に防げるリスクを減らせます。
      </div>

      {error && <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}

      {/* ナレッジ提案 */}
      <section className="space-y-2">
        <h3 className="font-semibold">ナレッジ候補 ({knowledge.length} 件)</h3>
        {knowledge.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            類似するナレッジが見つかりませんでした。タグを追加するか、タグ数を増やすと提案精度が向上します。
          </p>
        ) : (
          <ul className="space-y-2">
            {knowledge.map((k) => {
              const adoptedKey = `knowledge:${k.id}`;
              const isAdopted = k.alreadyLinked || adopted.has(adoptedKey);
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
                          類似度 {(k.score * 100).toFixed(0)}%
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">{k.snippet}</p>
                    </div>
                    <div className="shrink-0">
                      {isAdopted ? (
                        <Badge>紐付け済</Badge>
                      ) : canAdopt ? (
                        <Button size="sm" onClick={() => handleAdopt('knowledge', k.id)}>
                          このプロジェクトに紐付け
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
        <h3 className="font-semibold">過去課題 (雛形候補, {pastIssues.length} 件)</h3>
        <p className="text-xs text-muted-foreground">
          過去プロジェクトで解消された課題を雛形として取り込めます。
          採用すると state=&quot;未対応&quot; の新規課題として複製され、事前に備えた対応ができます。
        </p>
        {pastIssues.length === 0 ? (
          <p className="text-sm text-muted-foreground">類似する過去課題が見つかりませんでした。</p>
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
                          類似度 {(i.score * 100).toFixed(0)}%
                        </Badge>
                        {i.sourceProjectName && (
                          <Link
                            href={`/projects/${i.sourceProjectId}`}
                            className="text-xs text-info hover:underline"
                          >
                            出典: {i.sourceProjectName}
                          </Link>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">{i.snippet}</p>
                    </div>
                    <div className="shrink-0">
                      {isAdopted ? (
                        <Badge>採用済</Badge>
                      ) : canAdopt ? (
                        <Button size="sm" onClick={() => handleAdopt('issue', i.id)}>
                          雛形として採用
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
        <h3 className="font-semibold">過去振り返り ({retrospectives.length} 件)</h3>
        <p className="text-xs text-muted-foreground">
          過去プロジェクトの振り返り (問題点・次回事項) を参考情報として提示します。
          同種の失敗を繰り返さないために目を通してください。
        </p>
        {retrospectives.length === 0 ? (
          <p className="text-sm text-muted-foreground">類似する過去振り返りが見つかりませんでした。</p>
        ) : (
          <ul className="space-y-2">
            {retrospectives.map((r) => (
              <li key={r.id} className="rounded border p-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">振り返り ({r.conductedDate})</span>
                      <Badge variant="outline" title={scoreTooltip(r)}>
                        類似度 {(r.score * 100).toFixed(0)}%
                      </Badge>
                      {r.sourceProjectName && (
                        <Link
                          href={`/projects/${r.sourceProjectId}/retrospectives`}
                          className="text-xs text-info hover:underline"
                        >
                          出典: {r.sourceProjectName}
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

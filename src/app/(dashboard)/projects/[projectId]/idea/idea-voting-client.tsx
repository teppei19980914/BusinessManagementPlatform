'use client';

/**
 * 投票セッションタブ (ライブ投票 / 事前投票共通) (v1.5.0)
 *
 * アクティブ中: 自分の提出のみ表示 + 投票フォーム
 * クローズ後: 全提出 + 集計結果
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/toast-provider';
import { useFormatters } from '@/lib/use-formatters';
import type { VotingSessionDTO } from '@/services/idea-voting.service';

type Props = {
  projectId: string;
  kind: 'live' | 'pre';
  canSubmit: boolean;
  canManage: boolean;
};

const STATUS_LABELS: Record<string, string> = {
  all: 'すべて',
  active: 'アクティブ',
  closed: 'クローズ済み',
};

export function IdeaVotingClient({ projectId, kind, canSubmit, canManage }: Props) {
  const [sessions, setSessions] = useState<VotingSessionDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const { showSuccessKey, showErrorKey } = useToast();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setQ(searchInput), 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchInput]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ kind });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (q) params.set('q', q);
      const res = await fetch(`/api/projects/${projectId}/idea/voting?${params}`);
      if (!res.ok) throw new Error();
      const { data } = await res.json();
      setSessions(data);
    } catch {
      showErrorKey('idea.toastFetchVotingFailed');
    } finally {
      setLoading(false);
    }
  }, [projectId, kind, statusFilter, q, showErrorKey]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  const handleClose = async (sessionId: string) => {
    const res = await fetch(`/api/projects/${projectId}/idea/voting/${sessionId}/close`, {
      method: 'POST',
    });
    if (!res.ok) {
      showErrorKey('idea.toastCloseFailed');
      return;
    }
    showSuccessKey('idea.toastVotingClosed');
    load();
  };

  const handleDelete = async (sessionId: string) => {
    if (!confirm('この投票セッションを削除しますか？')) return;
    const res = await fetch(`/api/projects/${projectId}/idea/voting/${sessionId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      showErrorKey('idea.toastDeleteFailed');
      return;
    }
    showSuccessKey('idea.toastDeleted');
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-semibold text-sm">
          {kind === 'live' ? 'ライブ投票' : '事前投票'} セッション
        </h3>
        <div className="flex gap-2 text-sm flex-wrap">
          <input
            type="search"
            className="rounded border px-2 py-1 text-xs w-36"
            placeholder="キーワード検索..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <select
            className="rounded border px-2 py-1 text-xs"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            {Object.entries(STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
        {canManage && (
          <IdeaVotingCreateButton projectId={projectId} kind={kind} onCreated={load} />
        )}
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">読み込み中...</div>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          投票セッションがありません
        </p>
      ) : (
        <div className="space-y-3">
          {sessions.map((s) => (
            <IdeaVotingSessionCard
              key={s.id}
              session={s}
              projectId={projectId}
              canSubmit={canSubmit}
              canManage={canManage}
              onClose={handleClose}
              onDelete={handleDelete}
              onReload={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// セッション作成ボタン (簡易フォーム)
// ============================================================

function IdeaVotingCreateButton({
  projectId,
  kind,
  onCreated,
}: {
  projectId: string;
  kind: 'live' | 'pre';
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [voteType, setVoteType] = useState<'binary' | 'dot'>('binary');
  const [votesPerMember, setVotesPerMember] = useState(3);
  const [endsAt, setEndsAt] = useState('');
  const [durationMins, setDurationMins] = useState(10);
  const [binaryA, setBinaryA] = useState('賛成');
  const [binaryB, setBinaryB] = useState('反対');
  const [dotOptions, setDotOptions] = useState<string[]>(['', '', '']);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<{ title?: string; endsAt?: string; options?: string }>({});
  const { showSuccessKey, showErrorKey } = useToast();

  const handleSubmit = async () => {
    const newErrors: { title?: string; endsAt?: string; options?: string } = {};
    if (!title.trim()) newErrors.title = 'タイトルを入力してください';
    if (kind === 'live' && durationMins <= 0) newErrors.endsAt = '制限時間を入力してください';
    if (kind === 'pre' && !endsAt) newErrors.endsAt = '終了日時を選択してください';
    const options =
      voteType === 'binary'
        ? [binaryA, binaryB]
        : dotOptions.filter((o) => o.trim());
    if (voteType === 'binary' && (!binaryA.trim() || !binaryB.trim())) newErrors.options = '選択肢A・Bを両方入力してください';
    if (voteType === 'dot' && options.length < 2) newErrors.options = '選択肢を2件以上入力してください';
    if (Object.keys(newErrors).length > 0) { setErrors(newErrors); return; }
    setErrors({});
    setSubmitting(true);
    try {
      const endsAtIso = kind === 'live'
        ? new Date(Date.now() + durationMins * 60 * 1000).toISOString()
        : new Date(endsAt).toISOString();
      const res = await fetch(`/api/projects/${projectId}/idea/voting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          voteType,
          title,
          endsAt: endsAtIso,
          votesPerMember: voteType === 'dot' ? votesPerMember : undefined,
          options: options.map((label, i) => ({ label, displayOrder: i })),
        }),
      });
      if (!res.ok) {
        const body = await res.json();
        const code = body.error?.code;
        showErrorKey(
          code === 'INVALID_ENDS_AT' ? 'idea.toastInvalidEndsAt'
          : code === 'FORBIDDEN' ? 'idea.toastForbiddenCreate'
          : 'idea.toastCreateFailed',
        );
        return;
      }
      showSuccessKey('idea.toastVotingCreated');
      setOpen(false);
      setTitle('');
      setEndsAt('');
      setDotOptions(['', '', '']);
      onCreated();
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        + 新規作成
      </Button>
    );
  }

  return (
    <div className="rounded-md border p-4 space-y-3 bg-muted/30 w-full mt-2">
      <h4 className="text-sm font-medium">新規投票セッション作成</h4>
      <div className="space-y-2">
        <div>
          <input
            className="w-full rounded border px-3 py-1.5 text-sm"
            placeholder="タイトル"
            value={title}
            onChange={(e) => { setTitle(e.target.value); if (errors.title) setErrors((p) => ({ ...p, title: undefined })); }}
          />
          {errors.title && <p className="text-xs text-destructive mt-0.5">{errors.title}</p>}
        </div>
        <select
          className="w-full rounded border px-3 py-1.5 text-sm"
          value={voteType}
          onChange={(e) => setVoteType(e.target.value as 'binary' | 'dot')}
        >
          <option value="binary">二択投票</option>
          <option value="dot">ドット投票</option>
        </select>
        {voteType === 'dot' && (
          <div className="flex items-center gap-2 text-sm">
            <label>1人あたり票数:</label>
            <input
              type="number"
              min={1}
              max={10}
              className="w-16 rounded border px-2 py-1 text-sm"
              value={votesPerMember}
              onChange={(e) => setVotesPerMember(Number(e.target.value))}
            />
          </div>
        )}
        {voteType === 'binary' ? (
          <div>
            <div className="grid grid-cols-2 gap-2">
              <input
                className="rounded border px-3 py-1.5 text-sm"
                placeholder="選択肢A"
                value={binaryA}
                onChange={(e) => { setBinaryA(e.target.value); if (errors.options) setErrors((p) => ({ ...p, options: undefined })); }}
              />
              <input
                className="rounded border px-3 py-1.5 text-sm"
                placeholder="選択肢B"
                value={binaryB}
                onChange={(e) => { setBinaryB(e.target.value); if (errors.options) setErrors((p) => ({ ...p, options: undefined })); }}
              />
            </div>
            {errors.options && <p className="text-xs text-destructive mt-0.5">{errors.options}</p>}
          </div>
        ) : (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">選択肢（2〜10件）</p>
            {dotOptions.map((opt, i) => (
              <div key={i} className="flex gap-1.5 items-center">
                <input
                  className="flex-1 rounded border px-3 py-1.5 text-sm"
                  placeholder={`選択肢 ${i + 1}`}
                  value={opt}
                  onChange={(e) => {
                    const next = [...dotOptions];
                    next[i] = e.target.value;
                    setDotOptions(next);
                    if (errors.options) setErrors((p) => ({ ...p, options: undefined }));
                  }}
                />
                {dotOptions.length > 2 && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive text-sm px-1"
                    onClick={() => setDotOptions(dotOptions.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            {dotOptions.length < 10 && (
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() => setDotOptions([...dotOptions, ''])}
              >
                + 選択肢を追加
              </button>
            )}
            {errors.options && <p className="text-xs text-destructive mt-0.5">{errors.options}</p>}
          </div>
        )}
        <div>
          {kind === 'live' ? (
            <div className="flex items-center gap-2">
              <label className="text-sm shrink-0">制限時間:</label>
              <input
                type="number"
                min={1}
                max={180}
                className="w-20 rounded border px-2 py-1.5 text-sm"
                value={durationMins}
                onChange={(e) => { setDurationMins(Number(e.target.value)); if (errors.endsAt) setErrors((p) => ({ ...p, endsAt: undefined })); }}
              />
              <span className="text-sm text-muted-foreground">分</span>
            </div>
          ) : (
            <input
              type="datetime-local"
              className="w-full rounded border px-3 py-1.5 text-sm"
              value={endsAt}
              onChange={(e) => { setEndsAt(e.target.value); if (errors.endsAt) setErrors((p) => ({ ...p, endsAt: undefined })); }}
            />
          )}
          {errors.endsAt && <p className="text-xs text-destructive mt-0.5">{errors.endsAt}</p>}
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={handleSubmit} disabled={submitting}>
          作成
        </Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
          キャンセル
        </Button>
      </div>
    </div>
  );
}

// ============================================================
// セッションカード
// ============================================================

function IdeaVotingSessionCard({
  session,
  projectId,
  canSubmit,
  canManage,
  onClose,
  onDelete,
  onReload,
}: {
  session: VotingSessionDTO;
  projectId: string;
  canSubmit: boolean;
  canManage: boolean;
  onClose: (id: string) => void;
  onDelete: (id: string) => void;
  onReload: () => void;
}) {
  const { showSuccessKey, showErrorKey } = useToast();
  const { formatDateTimeSeconds } = useFormatters();
  const isActive = session.status === 'active';
  const isCreator = canManage;
  const ownSub = session.submissions.find((s) => s.isOwnSubmission);

  // ドット投票: 選択中の optionId リスト。リロード後は提出済み allocations で初期化。
  const [dotSelections, setDotSelections] = useState<string[]>(
    ownSub?.allocations.map((a) => a.optionId) ?? [],
  );
  const [dotSubmitting, setDotSubmitting] = useState(false);

  // セッション再取得後に選択状態を同期する
  useEffect(() => {
    const sub = session.submissions.find((s) => s.isOwnSubmission);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDotSelections(sub?.allocations.map((a) => a.optionId) ?? []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownSub?.id]);

  // 二択投票: クリックで即時1択提出
  const handleBinaryVote = async (optionId: string) => {
    const res = await fetch(`/api/projects/${projectId}/idea/voting/${session.id}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allocations: [{ optionId, votes: 1 }] }),
    });
    if (!res.ok) {
      const body = await res.json();
      showErrorKey(body.error?.code === 'SESSION_CLOSED' ? 'idea.toastVoteSessionClosed' : 'idea.toastVoteFailed');
      onReload();
      return;
    }
    showSuccessKey('idea.toastVoted');
    onReload();
  };

  // ドット投票: 選択肢をトグル (上限 = votesPerMember)
  const handleDotToggle = (optionId: string) => {
    setDotSelections((prev) => {
      if (prev.includes(optionId)) return prev.filter((id) => id !== optionId);
      if (prev.length >= (session.votesPerMember ?? 1)) return prev;
      return [...prev, optionId];
    });
  };

  // ドット投票: 選択済み全オプションを一括提出
  const handleDotSubmit = async () => {
    if (dotSelections.length === 0) return;
    setDotSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/idea/voting/${session.id}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          allocations: dotSelections.map((optionId) => ({ optionId, votes: 1 })),
        }),
      });
      if (!res.ok) {
        const body = await res.json();
        showErrorKey(body.error?.code === 'SESSION_CLOSED' ? 'idea.toastVoteSessionClosed' : 'idea.toastVoteFailed');
        onReload();
        return;
      }
      showSuccessKey('idea.toastVoted');
      onReload();
    } finally {
      setDotSubmitting(false);
    }
  };

  return (
    <div className="rounded-md border p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <p className="font-medium text-sm">{session.title}</p>
          <p className="text-xs text-muted-foreground">
            作成: {formatDateTimeSeconds(session.createdAt)}
            {' · '}
            終了: {formatDateTimeSeconds(session.endsAt)}
            {session.closedAt && ` · クローズ: ${formatDateTimeSeconds(session.closedAt)}`}
            {' · '}
            回答者: {session.totalRespondents}人
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="outline" className="text-xs font-normal">
            {session.voteType === 'binary' ? '二択投票' : `ドット投票 · ${session.votesPerMember ?? 1}票/人`}
          </Badge>
          <Badge variant={isActive ? 'default' : 'secondary'}>
            {isActive ? 'アクティブ' : 'クローズ'}
          </Badge>
          {isActive && isCreator && (
            <Button size="sm" variant="outline" onClick={() => onClose(session.id)}>
              締め切る
            </Button>
          )}
          {isCreator && (
            <Button size="sm" variant="ghost" onClick={() => onDelete(session.id)}
              className="text-destructive hover:text-destructive">
              削除
            </Button>
          )}
        </div>
      </div>

      {/* 選択肢 */}
      <div className="grid gap-2">
        {session.options.map((opt) => {
          const myAlloc = ownSub?.allocations.find((a) => a.optionId === opt.id);
          const isDotSelected = dotSelections.includes(opt.id);
          const totalVotes = opt.totalVotes ?? 0;

          return (
            <div key={opt.id} className="flex items-center gap-3">
              {isActive && canSubmit && session.voteType === 'binary' && (
                <Button
                  size="sm"
                  variant={myAlloc ? 'default' : 'outline'}
                  onClick={() => handleBinaryVote(opt.id)}
                >
                  {opt.label}
                </Button>
              )}
              {isActive && canSubmit && session.voteType === 'dot' && (
                <Button
                  size="sm"
                  variant={isDotSelected ? 'default' : 'outline'}
                  disabled={!isDotSelected && dotSelections.length >= (session.votesPerMember ?? 1)}
                  onClick={() => handleDotToggle(opt.id)}
                >
                  {opt.label}
                </Button>
              )}
              {(!isActive || !canSubmit) && (
                <span className="text-sm font-medium w-24 shrink-0">{opt.label}</span>
              )}
              {session.status === 'closed' && (
                <div className="flex-1">
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{
                        width: session.totalRespondents > 0
                          ? `${(totalVotes / session.totalRespondents) * 100}%`
                          : '0%',
                      }}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground">{totalVotes}票</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ドット投票: 選択カウンター + 一括投票ボタン */}
      {isActive && canSubmit && session.voteType === 'dot' && (
        <div className="flex items-center gap-3 pt-1">
          <span className="text-xs text-muted-foreground">
            {dotSelections.length} / {session.votesPerMember ?? 1} 票選択中
          </span>
          <Button
            size="sm"
            onClick={handleDotSubmit}
            disabled={dotSelections.length === 0 || dotSubmitting}
          >
            投票する
          </Button>
        </div>
      )}

      {isActive && session.hasSubmitted && session.voteType === 'binary' && (
        <p className="text-xs text-muted-foreground">投票済み (変更可)</p>
      )}
      {isActive && session.hasSubmitted && session.voteType === 'dot' && (
        <p className="text-xs text-muted-foreground">投票済み (選択を変えて再投票できます)</p>
      )}
    </div>
  );
}

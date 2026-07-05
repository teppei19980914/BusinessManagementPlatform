'use client';

/**
 * ホワイトボードタブ (v1.5.0)
 *
 * アクティブ中: 自分の付箋のみ表示 + 投稿フォーム
 * クローズ後: 全付箋を表示 (isOwnNote フラグで識別)
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/toast-provider';
import { useFormatters } from '@/lib/use-formatters';
import type { WhiteboardSessionDTO } from '@/services/idea-whiteboard.service';

type Props = {
  projectId: string;
  canSubmit: boolean;
  canManage: boolean;
};

const STATUS_LABELS: Record<string, string> = {
  all: 'すべて',
  active: 'アクティブ',
  closed: 'クローズ済み',
};

export function IdeaWhiteboardClient({ projectId, canSubmit, canManage }: Props) {
  const [sessions, setSessions] = useState<WhiteboardSessionDTO[]>([]);
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
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (q) params.set('q', q);
      const qs = params.toString();
      const res = await fetch(`/api/projects/${projectId}/idea/whiteboard${qs ? `?${qs}` : ''}`);
      if (!res.ok) throw new Error();
      const { data } = await res.json();
      setSessions(data);
    } catch {
      showErrorKey('idea.toastFetchWhiteboardFailed');
    } finally {
      setLoading(false);
    }
  }, [projectId, statusFilter, q, showErrorKey]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  const handleClose = async (sessionId: string) => {
    const res = await fetch(`/api/projects/${projectId}/idea/whiteboard/${sessionId}/close`, {
      method: 'POST',
    });
    if (!res.ok) {
      showErrorKey('idea.toastCloseFailed');
      return;
    }
    showSuccessKey('idea.toastBoardClosed');
    load();
  };

  const handleDelete = async (sessionId: string) => {
    if (!confirm('このホワイトボードを削除しますか？')) return;
    const res = await fetch(`/api/projects/${projectId}/idea/whiteboard/${sessionId}`, {
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
        <h3 className="font-semibold text-sm">ホワイトボード</h3>
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
        {canManage && <CreateWhiteboardButton projectId={projectId} onCreated={load} />}
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">読み込み中...</div>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          ホワイトボードがありません
        </p>
      ) : (
        <div className="space-y-4">
          {sessions.map((s) => (
            <WhiteboardSessionCard
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

function CreateWhiteboardButton({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<{ title?: string; endsAt?: string }>({});
  const { showSuccessKey, showErrorKey } = useToast();

  const handleSubmit = async () => {
    const newErrors: { title?: string; endsAt?: string } = {};
    if (!title.trim()) newErrors.title = 'タイトルを入力してください';
    if (!endsAt) newErrors.endsAt = '終了日時を選択してください';
    if (Object.keys(newErrors).length > 0) { setErrors(newErrors); return; }
    setErrors({});
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/idea/whiteboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, endsAt: new Date(endsAt).toISOString() }),
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
      showSuccessKey('idea.toastBoardCreated');
      setOpen(false);
      setTitle('');
      setEndsAt('');
      onCreated();
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return <Button size="sm" onClick={() => setOpen(true)}>+ 新規作成</Button>;
  }

  return (
    <div className="rounded-md border p-4 space-y-3 bg-muted/30 w-full mt-2">
      <div>
        <input
          className="w-full rounded border px-3 py-1.5 text-sm"
          placeholder="タイトル"
          value={title}
          onChange={(e) => { setTitle(e.target.value); if (errors.title) setErrors((p) => ({ ...p, title: undefined })); }}
        />
        {errors.title && <p className="text-xs text-destructive mt-0.5">{errors.title}</p>}
      </div>
      <div>
        <input
          type="datetime-local"
          className="w-full rounded border px-3 py-1.5 text-sm"
          value={endsAt}
          onChange={(e) => { setEndsAt(e.target.value); if (errors.endsAt) setErrors((p) => ({ ...p, endsAt: undefined })); }}
        />
        {errors.endsAt && <p className="text-xs text-destructive mt-0.5">{errors.endsAt}</p>}
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={handleSubmit} disabled={submitting}>作成</Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(false)}>キャンセル</Button>
      </div>
    </div>
  );
}

function WhiteboardSessionCard({
  session,
  projectId,
  canSubmit,
  canManage,
  onClose,
  onDelete,
  onReload,
}: {
  session: WhiteboardSessionDTO;
  projectId: string;
  canSubmit: boolean;
  canManage: boolean;
  onClose: (id: string) => void;
  onDelete: (id: string) => void;
  onReload: () => void;
}) {
  const [noteContent, setNoteContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { showSuccessKey, showErrorKey } = useToast();
  const { formatDateTimeSeconds } = useFormatters();
  const isActive = session.status === 'active';

  const handleAddNote = async () => {
    if (!noteContent.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/idea/whiteboard/${session.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteContent }),
      });
      if (!res.ok) {
        const body = await res.json();
        showErrorKey(body.error?.code === 'SESSION_CLOSED' ? 'idea.toastNoteSessionClosed' : 'idea.toastPostFailed');
        onReload();
        return;
      }
      setNoteContent('');
      showSuccessKey('idea.toastNotePosted');
      onReload();
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteNote = async (noteId: string) => {
    const res = await fetch(
      `/api/projects/${projectId}/idea/whiteboard/${session.id}/notes/${noteId}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      showErrorKey('idea.toastDeleteFailed');
      return;
    }
    onReload();
  };

  return (
    <div className="rounded-md border p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-sm">{session.title}</p>
          <p className="text-xs text-muted-foreground">
            作成: {formatDateTimeSeconds(session.createdAt)}
            {' · '}
            終了: {formatDateTimeSeconds(session.endsAt)}
            {session.closedAt && ` · クローズ: ${formatDateTimeSeconds(session.closedAt)}`}
            {' · '}
            付箋: {session.totalNotes}件
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant={isActive ? 'default' : 'secondary'}>
            {isActive ? 'アクティブ' : 'クローズ'}
          </Badge>
          {isActive && canManage && (
            <Button size="sm" variant="outline" onClick={() => onClose(session.id)}>
              締め切る
            </Button>
          )}
          {canManage && (
            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive"
              onClick={() => onDelete(session.id)}>
              削除
            </Button>
          )}
        </div>
      </div>

      {/* 付箋 */}
      <div className="flex flex-wrap gap-2">
        {session.notes.map((note) => (
          <div
            key={note.id}
            className="relative rounded bg-yellow-100 dark:bg-yellow-900/30 border border-yellow-300 dark:border-yellow-700 px-3 py-2 text-sm max-w-[200px]"
          >
            <p className="whitespace-pre-wrap break-words">{note.content}</p>
            {note.category && (
              <Badge variant="outline" className="mt-1 text-xs">{note.category}</Badge>
            )}
            {note.isOwnNote && isActive && (
              <button
                className="absolute top-1 right-1 text-xs text-muted-foreground hover:text-destructive"
                onClick={() => handleDeleteNote(note.id)}
                aria-label="削除"
              >
                ×
              </button>
            )}
          </div>
        ))}
        {session.notes.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {isActive ? '付箋を投稿してください' : '付箋がありません'}
          </p>
        )}
      </div>

      {/* 投稿フォーム */}
      {isActive && canSubmit && (
        <div className="flex gap-2">
          <textarea
            className="flex-1 rounded border px-3 py-1.5 text-sm resize-none"
            placeholder="アイデアを書いてください..."
            rows={2}
            value={noteContent}
            onChange={(e) => setNoteContent(e.target.value)}
          />
          <Button size="sm" onClick={handleAddNote} disabled={submitting || !noteContent.trim()}>
            投稿
          </Button>
        </div>
      )}
    </div>
  );
}

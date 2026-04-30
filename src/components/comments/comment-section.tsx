'use client';

/**
 * CommentSection (PR #199): 編集 dialog 内の汎用コメント UI。
 *
 * 特徴:
 *   - **readOnly モードでも投稿可能** (要件 Q4: 全○○ では data 編集不可だがコメント可)。
 *     呼び出し側 dialog の `<fieldset disabled={readOnly}>` の **外側** に配置すること。
 *   - 並び順は新しい順 (createdAt DESC、サーバ側で確定)。
 *   - 編集 / 削除は **投稿者本人 OR システム管理者** のみ表示 (要件 Q5)。
 *   - **nested form 禁止** (PR #64 Phase B 要件 4 と同じ罠を回避):
 *       外側 dialog の <form> 内に新たな <form> を入れず、<div> + onKeyDown で Enter 制御。
 *       投稿/保存ボタンは type="button" + onClick で発火させる。
 *
 * セキュリティ:
 *   - content は React の textContent で挿入し XSS 化しない (innerHTML 不使用)。
 *   - サーバ側で trim + 1〜2000 文字バリデート。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
import { useSession } from 'next-auth/react';
import { formatDateTimeFull } from '@/lib/format';
import { COMMENT_CONTENT_MAX_LENGTH } from '@/config';
import type { CommentEntityType } from '@/lib/validators/comment';
import type { CommentDTO } from '@/services/comment.service';

type Props = {
  entityType: CommentEntityType;
  entityId: string;
};

/** Textarea を提供 (shadcn の textarea がないので最小実装) */
function CommentTextarea({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      maxLength={COMMENT_CONTENT_MAX_LENGTH}
      aria-label={ariaLabel}
      className="min-h-[72px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}

export function CommentSection({ entityType, entityId }: Props) {
  const t = useTranslations('comment');
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();
  const session = useSession();
  const currentUserId = session.data?.user?.id;
  const isAdmin = session.data?.user?.systemRole === 'admin';

  type ListState =
    | { loaded: false }
    | { loaded: true; items: CommentDTO[] };
  const [listState, setListState] = useState<ListState>({ loaded: false });
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');

  const reload = useCallback(async () => {
    const url = `/api/comments?entityType=${entityType}&entityId=${entityId}`;
    const res = await fetch(url);
    if (!res.ok) {
      setError(t('fetchFailed'));
      setListState({ loaded: true, items: [] });
      return;
    }
    const json = await res.json();
    setListState({ loaded: true, items: json.data ?? [] });
    setError('');
  }, [entityType, entityId, t]);

  // 初回 mount + entity 変更時にコメントをサーバから同期取得する。
  // 外部 API 同期のため react-hooks/set-state-in-effect 例外規定の対象 (AttachmentList と同様)。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const items = listState.loaded ? listState.items : [];
  const loaded = listState.loaded;

  async function handlePost() {
    setError('');
    const content = draft.trim();
    if (!content) {
      setError(t('empty'));
      return;
    }
    const res = await withLoading(() =>
      fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityType, entityId, content }),
      }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const msg = json.error?.message || json.error?.details?.[0]?.message || t('postFailed');
      setError(msg);
      showError(t('postFailed'));
      return;
    }
    setDraft('');
    showSuccess(t('postSuccess'));
    await reload();
  }

  function startEdit(c: CommentDTO) {
    setEditingId(c.id);
    setEditingContent(c.content);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingContent('');
  }

  async function handleSaveEdit(id: string) {
    const content = editingContent.trim();
    if (!content) {
      setError(t('empty'));
      return;
    }
    const res = await withLoading(() =>
      fetch(`/api/comments/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }),
    );
    if (!res.ok) {
      setError(t('saveFailed'));
      showError(t('saveFailed'));
      return;
    }
    cancelEdit();
    showSuccess(t('saveSuccess'));
    await reload();
  }

  async function handleDelete(id: string) {
    if (!confirm(t('deleteConfirm'))) return;
    const res = await withLoading(() =>
      fetch(`/api/comments/${id}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      setError(t('deleteFailed'));
      showError(t('deleteFailed'));
      return;
    }
    showSuccess(t('deleteSuccess'));
    await reload();
  }

  function canMutate(c: CommentDTO): boolean {
    return isAdmin || c.userId === currentUserId;
  }

  return (
    <div className="space-y-3">
      <Label>{t('section')}</Label>

      {error && (
        <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>
      )}

      {/* 投稿フォーム (要件 Q4: dialog readOnly でも常に有効) */}
      {/* nested form 回避: <div> + Enter キーは抑止し、Ctrl/Meta+Enter で投稿 */}
      <div
        className="space-y-2 rounded border bg-muted/40 p-2"
        onKeyDown={(e) => {
          // 通常 Enter は改行 (textarea 既定動作)。Ctrl/Meta+Enter で投稿させる。
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void handlePost();
          }
        }}
      >
        <CommentTextarea
          value={draft}
          onChange={setDraft}
          placeholder={t('placeholder')}
          ariaLabel={t('placeholder')}
        />
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={() => void handlePost()}>
            {t('post')}
          </Button>
        </div>
      </div>

      {/* 既存コメント (新しい順) */}
      {loaded && items.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('noComments')}</p>
      )}

      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((c) => {
            const editing = editingId === c.id;
            return (
              <li
                key={c.id}
                className="rounded border bg-card p-2 text-sm"
                data-testid="comment-item"
                data-comment-id={c.id}
              >
                <div className="mb-1 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground" data-testid="comment-author">
                    {c.userName ?? '(unknown)'}
                  </span>
                  <span title={formatDateTimeFull(c.updatedAt)}>
                    {formatDateTimeFull(c.createdAt)}
                    {c.edited && <span className="ml-1">{t('edited')}</span>}
                  </span>
                </div>
                {editing ? (
                  <div
                    className="space-y-2"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        void handleSaveEdit(c.id);
                      }
                    }}
                  >
                    <CommentTextarea
                      value={editingContent}
                      onChange={setEditingContent}
                      placeholder={t('placeholder')}
                      ariaLabel={t('placeholder')}
                    />
                    <div className="flex justify-end gap-2">
                      <Button type="button" size="sm" variant="ghost" onClick={cancelEdit}>
                        {t('cancel')}
                      </Button>
                      <Button type="button" size="sm" onClick={() => void handleSaveEdit(c.id)}>
                        {t('save')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* whitespace-pre-wrap で改行を保持。textContent 経由なので XSS 安全 */}
                    <p className="whitespace-pre-wrap break-words" data-testid="comment-content">
                      {c.content}
                    </p>
                    {canMutate(c) && (
                      <div className="mt-1 flex justify-end gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => startEdit(c)}
                        >
                          {t('edit')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          onClick={() => void handleDelete(c.id)}
                        >
                          {t('delete')}
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

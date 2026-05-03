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

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
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
import type { MentionInput, MentionKind } from '@/lib/validators/mention';

type Props = {
  entityType: CommentEntityType;
  entityId: string;
  /**
   * コメント投稿フォームを表示するかどうか (PR feat/notification-edit-dialog / 2026-05-01)。
   * 既定は true (= 認証済全員 OK の entity 用)。stakeholder / customer / task のように
   * 投稿者を更に制限する場合、呼出側で false を渡してフォームを非表示にする (二重防御、
   * 一次防御は API の authorizeForComment)。
   *
   * 非表示時は閲覧 + 自分が過去投稿したコメントの編集/削除のみ可能。
   */
  canPost?: boolean;
  /** canPost=false 時に表示する補足メッセージ (任意、未指定時は何も表示しない) */
  postDisabledHint?: string;
};

/**
 * 現在のページ URL から mention context を判定する (PR feat/comment-mentions、Q3)。
 *   - /projects/[id]/tasks → 'wbs'
 *   - /projects/[id]/... → 'project_list'
 *   - その他 (/risks, /issues, /retrospectives, /knowledge, /customers) → 'cross_list'
 */
function detectMentionContext(pathname: string): 'wbs' | 'project_list' | 'cross_list' {
  if (/^\/projects\/[^/]+\/tasks/.test(pathname)) return 'wbs';
  if (/^\/projects\/[^/]+/.test(pathname)) return 'project_list';
  return 'cross_list';
}

type MentionCandidatesResponse = {
  data: {
    groups: { kind: MentionKind; label: string }[];
    users: { id: string; name: string; email: string }[];
  };
};

/**
 * Mention 補完付き Textarea (PR feat/comment-mentions)。
 *
 * @ をタイプすると候補ポップアップが下に出る。候補をクリックすると `@<label>` をテキストに挿入し、
 * mentions[] に構造化データを追加 (kind + targetUserId)。
 *
 * 実装方針:
 *   - cursor 直前の `@` を正規表現で検出 (/(?:^|\s)@([\p{L}\p{N}_-]*)$/u)
 *   - debounced fetch (250ms) で候補を取得
 *   - 候補を click で確定 (キーボードナビは MVP 後拡張)
 *   - 確定時: `@partial` を `@<label> ` に置換、mentions に追加
 *
 * セキュリティ:
 *   - 表示は React の textContent ベース、innerHTML 不使用 (XSS 安全)
 */
function MentionAutocompleteTextarea({
  value,
  onChange,
  mentions,
  onMentionsChange,
  entityType,
  entityId,
  context,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  mentions: MentionInput[];
  onMentionsChange: (m: MentionInput[]) => void;
  entityType: CommentEntityType;
  entityId: string;
  context: 'wbs' | 'project_list' | 'cross_list';
  placeholder: string;
  ariaLabel: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [showSuggest, setShowSuggest] = useState(false);
  const [candidates, setCandidates] = useState<MentionCandidatesResponse['data']>({
    groups: [],
    users: [],
  });
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const matchStartRef = useRef<number>(0);

  /** カーソル直前の @ 部分一致 (query 文字列) を抽出する。なければ null。 */
  function detectMentionMatch(text: string, cursor: number): { matchStart: number; query: string } | null {
    const before = text.slice(0, cursor);
    // (^|whitespace)@(letters/digits/_/-)*  の最後マッチ
    const m = before.match(/(?:^|\s)@([\p{L}\p{N}_-]*)$/u);
    if (!m) return null;
    const matchStart = before.length - m[0].length + (m[0].startsWith('@') ? 0 : 1); // 先頭が @ じゃない (whitespace+@) なら 1 文字オフセット
    return { matchStart, query: m[1] };
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const newValue = e.target.value;
    onChange(newValue);
    const cursor = e.target.selectionStart;
    const match = detectMentionMatch(newValue, cursor);
    if (match) {
      matchStartRef.current = match.matchStart;
      setShowSuggest(true);
      // debounce fetch
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        const params = new URLSearchParams({
          entityType,
          entityId,
          context,
          query: match.query,
        });
        void fetch(`/api/mention-candidates?${params.toString()}`)
          .then((res) => (res.ok ? res.json() : null))
          .then((json: MentionCandidatesResponse | null) => {
            if (json?.data) setCandidates(json.data);
          })
          .catch(() => {
            /* 候補取得失敗は silent (UX を阻害しない) */
          });
      }, 250);
    } else {
      setShowSuggest(false);
    }
  }

  function handleSelectGroup(g: { kind: MentionKind; label: string }) {
    insertMention(`@${g.label} `, { kind: g.kind });
  }

  function handleSelectUser(u: { id: string; name: string }) {
    insertMention(`@${u.name} `, { kind: 'user', targetUserId: u.id });
  }

  function insertMention(insertText: string, mention: MentionInput) {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart;
    const matchStart = matchStartRef.current;
    // matchStart..cursor を insertText で置換
    const newValue = value.slice(0, matchStart) + insertText + value.slice(cursor);
    onChange(newValue);
    onMentionsChange([...mentions, mention]);
    setShowSuggest(false);
    // 次フレームで cursor 位置を挿入後の末尾に移動
    setTimeout(() => {
      ta.focus();
      const newCursor = matchStart + insertText.length;
      ta.setSelectionRange(newCursor, newCursor);
    }, 0);
  }

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        maxLength={COMMENT_CONTENT_MAX_LENGTH}
        aria-label={ariaLabel}
        className="min-h-[72px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      />
      {showSuggest && (candidates.groups.length > 0 || candidates.users.length > 0) && (
        <ul
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-md border bg-card shadow-md"
          data-testid="mention-suggest"
        >
          {candidates.groups.map((g) => (
            <li key={`g:${g.kind}`}>
              <button
                type="button"
                onClick={() => handleSelectGroup(g)}
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span className="text-info">@{g.label}</span>
                <span className="ml-2 text-xs text-muted-foreground">グループ</span>
              </button>
            </li>
          ))}
          {candidates.users.map((u) => (
            <li key={`u:${u.id}`}>
              <button
                type="button"
                onClick={() => handleSelectUser(u)}
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span>@{u.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">{u.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 既存の plain textarea (編集モード用、mention 補完不要な箇所で再利用) */
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

export function CommentSection({ entityType, entityId, canPost = true, postDisabledHint }: Props) {
  const t = useTranslations('comment');
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();
  const session = useSession();
  const currentUserId = session.data?.user?.id;
  const pathname = usePathname();
  const mentionContext = detectMentionContext(pathname ?? '');

  type ListState =
    | { loaded: false }
    | { loaded: true; items: CommentDTO[] };
  const [listState, setListState] = useState<ListState>({ loaded: false });
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [draftMentions, setDraftMentions] = useState<MentionInput[]>([]);
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
        body: JSON.stringify({ entityType, entityId, content, mentions: draftMentions }),
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
    setDraftMentions([]);
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

  /**
   * 編集 / 削除ボタンの表示判定。
   *
   * 2026-05-01 PR feat/notification-deep-link-completion: **投稿者本人のみ表示** に厳格化
   *   (旧仕様は admin も表示していたが、API 側は §5.51 で既に admin 救済を外しており UI が不整合だった)。
   *   admin がボタンを押しても 403 を返すだけだったため UI を API に合わせる方向で揃える。
   *   admin が他人コメントを操作したい場合は entity ごとカスケード削除に委ねる (§5.51 既定方針)。
   */
  function canMutate(c: CommentDTO): boolean {
    return c.userId === currentUserId;
  }

  return (
    <div className="space-y-3">
      <Label>{t('section')}</Label>

      {error && (
        <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>
      )}

      {/* 投稿フォーム (要件 Q4: dialog readOnly でも常に有効、ただし canPost=false の entity では非表示) */}
      {/* nested form 回避: <div> + Enter キーは抑止し、Ctrl/Meta+Enter で投稿 */}
      {canPost ? (
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
          <MentionAutocompleteTextarea
            value={draft}
            onChange={setDraft}
            mentions={draftMentions}
            onMentionsChange={setDraftMentions}
            entityType={entityType}
            entityId={entityId}
            context={mentionContext}
            placeholder={t('placeholder')}
            ariaLabel={t('placeholder')}
          />
          <div className="flex items-center justify-between">
            {/* メンション件数の確認チップ (UX 補助) */}
            <span className="text-xs text-muted-foreground">
              {draftMentions.length > 0 ? t('mentionsCount', { count: draftMentions.length }) : ''}
            </span>
            <Button type="button" size="sm" onClick={() => void handlePost()}>
              {t('post')}
            </Button>
          </div>
        </div>
      ) : postDisabledHint ? (
        <p className="rounded border bg-muted/30 p-2 text-xs text-muted-foreground" data-testid="comment-post-disabled-hint">
          {postDisabledHint}
        </p>
      ) : null}

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

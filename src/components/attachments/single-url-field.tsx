'use client';

/**
 * SingleUrlField (PR #64 Phase 1): 単数 URL スロット用コンポーネント。
 *
 * 用途:
 *   - Knowledge の `source` (一次情報源 URL) など、1 つだけ設定する URL フィールド
 *   - Project の `primary` (中心となる資料) など
 *
 * サーバ側で SINGLE_SLOTS (primary / source) は「新規作成時に既存行を論理削除して置換」
 * する挙動をとるため、UI 側も「編集時は新しい URL を POST する」だけで正しく更新される。
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLoading } from '@/components/loading-overlay';
import type { AttachmentEntityType } from '@/lib/validators/attachment';
import type { AttachmentDTO } from '@/services/attachment.service';

type Props = {
  entityType: AttachmentEntityType;
  entityId: string;
  /** 単数スロット名 (例: 'primary', 'source') */
  slot: string;
  canEdit: boolean;
  /** 見出しラベル (例: '一次情報源 URL') */
  label: string;
  /** 表示名のデフォルト (例: 'ドキュメント')。ユーザは編集可能 */
  defaultDisplayName?: string;
};

export function SingleUrlField({
  entityType,
  entityId,
  slot,
  canEdit,
  label,
  defaultDisplayName = 'ドキュメント',
}: Props) {
  const { withLoading } = useLoading();
  // react-hooks/set-state-in-effect 回避: loaded と current を 1 つの state にまとめる
  type CurrentState =
    | { loaded: false }
    | { loaded: true; current: AttachmentDTO | null };
  const [state, setState] = useState<CurrentState>({ loaded: false });
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(defaultDisplayName);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const res = await fetch(
      `/api/attachments?entityType=${entityType}&entityId=${entityId}&slot=${slot}`,
    );
    if (!res.ok) {
      setError('添付の取得に失敗しました');
      setState({ loaded: true, current: null });
      return;
    }
    const json = await res.json();
    const first = (json.data ?? [])[0] as AttachmentDTO | undefined;
    setState({ loaded: true, current: first ?? null });
    setError('');
  }, [entityType, entityId, slot]);

  // 初回 mount 時と entity 変更時に単数スロット添付をサーバから同期取得する。
  // これは外部システム (API) との同期であり react-hooks/set-state-in-effect の
  // 警告例外に該当する (src/lib/use-session-state.ts も同等の eslint-disable 運用)。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const loaded = state.loaded;
  const current = state.loaded ? state.current : null;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const res = await withLoading(() =>
      fetch('/api/attachments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityType,
          entityId,
          slot,
          displayName: displayName || defaultDisplayName,
          url,
        }),
      }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error?.message || json.error?.details?.[0]?.message || '保存に失敗しました');
      return;
    }
    setEditing(false);
    setDisplayName(defaultDisplayName);
    setUrl('');
    await reload();
  }

  async function handleClear() {
    if (!current) return;
    if (!confirm('この URL を削除しますか？')) return;
    const res = await withLoading(() =>
      fetch(`/api/attachments/${current.id}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      setError('削除に失敗しました');
      return;
    }
    await reload();
  }

  return (
    <div className="space-y-2">
      <Label>{label}</Label>

      {error && <div className="rounded-md bg-red-50 p-2 text-sm text-red-600">{error}</div>}

      {!editing && current && (
        <div className="flex items-center gap-2 rounded border px-2 py-1 text-sm">
          <a
            href={current.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 truncate text-blue-600 hover:underline"
            title={current.url}
          >
            {current.displayName}
          </a>
          {canEdit && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDisplayName(current.displayName);
                  setUrl(current.url);
                  setEditing(true);
                }}
              >
                編集
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-red-600"
                onClick={handleClear}
              >
                削除
              </Button>
            </>
          )}
        </div>
      )}

      {!editing && !current && loaded && (
        <>
          {canEdit ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
              URL を設定
            </Button>
          ) : (
            <p className="text-sm text-gray-500">未設定</p>
          )}
        </>
      )}

      {editing && canEdit && (
        <form onSubmit={handleSave} className="flex items-end gap-2 rounded border bg-gray-50 p-2">
          <div className="flex-1 space-y-1">
            <Label className="text-xs">表示名</Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={200}
            />
          </div>
          <div className="flex-[2] space-y-1">
            <Label className="text-xs">URL</Label>
            <Input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
              maxLength={2000}
              pattern="https?://.*"
              required
            />
          </div>
          <Button type="submit" size="sm">保存</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
            取消
          </Button>
        </form>
      )}
    </div>
  );
}

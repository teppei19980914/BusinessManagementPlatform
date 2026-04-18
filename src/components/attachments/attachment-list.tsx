'use client';

/**
 * AttachmentList (PR #64 Phase 1): 複数 URL 添付 UI コンポーネント。
 *
 * DRY 原則 (DESIGN.md §21.2):
 *   6 エンティティ (project/task/estimate/risk/retrospective/knowledge) で同一の
 *   UI/UX を提供するため共通コンポーネント化。単数スロット版 `SingleUrlField`
 *   と基本ロジックを共有する。
 *
 * セキュリティ:
 *   URL はサーバ側バリデータで http(s) スキームのみ受理。表示側も
 *   <a rel="noopener noreferrer" target="_blank"> を徹底し tabnabbing を防ぐ。
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
  /** 絞り込みスロット (デフォルト 'general') */
  slot?: string;
  /** 追加・編集・削除の操作を許可するか */
  canEdit: boolean;
  /** 見出しラベル (例: '関連ドキュメント') */
  label?: string;
};

export function AttachmentList({
  entityType,
  entityId,
  slot = 'general',
  canEdit,
  label = '関連 URL',
}: Props) {
  const { withLoading } = useLoading();
  // loaded=false の間は空一覧メッセージを出さないため、1 つの state にまとめる
  // (react-hooks/set-state-in-effect 回避: effect 内の setState を 1 回に集約)
  type ListState =
    | { loaded: false }
    | { loaded: true; items: AttachmentDTO[] };
  const [listState, setListState] = useState<ListState>({ loaded: false });
  const [error, setError] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newUrl, setNewUrl] = useState('');

  const reload = useCallback(async () => {
    const url = `/api/attachments?entityType=${entityType}&entityId=${entityId}&slot=${slot}`;
    const res = await fetch(url);
    if (!res.ok) {
      setError('添付の取得に失敗しました');
      setListState({ loaded: true, items: [] });
      return;
    }
    const json = await res.json();
    setListState({ loaded: true, items: json.data ?? [] });
    setError('');
  }, [entityType, entityId, slot]);

  // 初回 mount 時と entity 変更時に添付一覧をサーバから同期取得する。
  // これは外部システム (API) との同期であり react-hooks/set-state-in-effect の
  // 警告例外に該当する (src/lib/use-session-state.ts も同等の eslint-disable 運用)。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const items = listState.loaded ? listState.items : [];
  const loaded = listState.loaded;

  async function handleAdd(e: React.FormEvent) {
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
          displayName: newDisplayName,
          url: newUrl,
        }),
      }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error?.message || json.error?.details?.[0]?.message || '追加に失敗しました');
      return;
    }
    setNewDisplayName('');
    setNewUrl('');
    await reload();
  }

  async function handleDelete(id: string) {
    if (!confirm('この添付を削除しますか？')) return;
    const res = await withLoading(() =>
      fetch(`/api/attachments/${id}`, { method: 'DELETE' }),
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

      {loaded && items.length === 0 && !canEdit && (
        <p className="text-sm text-gray-500">添付はありません</p>
      )}

      {items.length > 0 && (
        <ul className="space-y-1">
          {items.map((a) => (
            <li key={a.id} className="flex items-center gap-2 rounded border px-2 py-1 text-sm">
              <a
                href={a.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 truncate text-blue-600 hover:underline"
                title={a.url}
              >
                {a.displayName}
              </a>
              {canEdit && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-red-600"
                  onClick={() => handleDelete(a.id)}
                >
                  削除
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <form onSubmit={handleAdd} className="flex items-end gap-2 rounded border bg-gray-50 p-2">
          <div className="flex-1 space-y-1">
            <Label className="text-xs">表示名</Label>
            <Input
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              placeholder="例: 設計書"
              maxLength={200}
              required
            />
          </div>
          <div className="flex-[2] space-y-1">
            <Label className="text-xs">URL</Label>
            <Input
              type="url"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="https://..."
              maxLength={2000}
              pattern="https?://.*"
              required
            />
          </div>
          <Button type="submit" size="sm">追加</Button>
        </form>
      )}
    </div>
  );
}

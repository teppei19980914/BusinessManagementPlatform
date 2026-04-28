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
import { useTranslations } from 'next-intl';
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
  /** 見出しラベル (省略時は attachment.relatedUrl を使用) */
  label?: string;
};

export function AttachmentList({
  entityType,
  entityId,
  slot = 'general',
  canEdit,
  label,
}: Props) {
  const t = useTranslations('attachment');
  const tAction = useTranslations('action');
  const { withLoading } = useLoading();
  const resolvedLabel = label ?? t('relatedUrl');
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
      setError(t('fetchFailed'));
      setListState({ loaded: true, items: [] });
      return;
    }
    const json = await res.json();
    setListState({ loaded: true, items: json.data ?? [] });
    setError('');
  }, [entityType, entityId, slot, t]);

  // 初回 mount 時と entity 変更時に添付一覧をサーバから同期取得する。
  // これは外部システム (API) との同期であり react-hooks/set-state-in-effect の
  // 警告例外に該当する (src/lib/use-session-state.ts も同等の eslint-disable 運用)。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const items = listState.loaded ? listState.items : [];
  const loaded = listState.loaded;

  // Phase B 要件 4 (2026-04-28): 編集 dialog 内 (= 外側 form 内) で添付追加ボタンを
  //   押すと、外側の編集 form が submit されてしまうバグ修正。原因は HTML の
  //   nested forms 禁止仕様: 内部 <form> は parser が無効化し、type="submit"
  //   ボタンが外側 form の submit を発火する。
  //
  //   修正: 内部 <form onSubmit> をやめて <div> + <Button type="button" onClick>
  //   に変更し、Enter キーでの誤 submit と外側 form 巻き込みを完全遮断する。
  async function handleAdd() {
    setError('');
    if (!newDisplayName.trim() || !newUrl.trim()) {
      setError(t('addFailed'));
      return;
    }
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
      setError(json.error?.message || json.error?.details?.[0]?.message || t('addFailed'));
      return;
    }
    setNewDisplayName('');
    setNewUrl('');
    await reload();
  }

  async function handleDelete(id: string) {
    if (!confirm(t('deleteConfirm'))) return;
    const res = await withLoading(() =>
      fetch(`/api/attachments/${id}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      setError(t('deleteFailed'));
      return;
    }
    await reload();
  }

  return (
    <div className="space-y-2">
      <Label>{resolvedLabel}</Label>

      {error && <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}

      {loaded && items.length === 0 && !canEdit && (
        <p className="text-sm text-muted-foreground">{t('noAttachments')}</p>
      )}

      {items.length > 0 && (
        <ul className="space-y-1">
          {items.map((a) => (
            <li key={a.id} className="flex items-center gap-2 rounded border px-2 py-1 text-sm">
              <a
                href={a.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 truncate text-info hover:underline"
                title={a.url}
              >
                {a.displayName}
              </a>
              {canEdit && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => handleDelete(a.id)}
                >
                  {tAction('delete')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        // Phase B 要件 4: nested form 回避のため <div> + onKeyDown で Enter 制御
        <div
          className="flex items-end gap-2 rounded border bg-muted p-2"
          onKeyDown={(e) => {
            // Enter で外側 form の submit を発火させない (Enter を「追加」ボタンに割当)
            if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
              e.preventDefault();
              void handleAdd();
            }
          }}
        >
          <div className="flex-1 space-y-1">
            <Label className="text-xs">{t('displayName')}</Label>
            <Input
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              placeholder={t('exampleSpec')}
              maxLength={200}
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
            />
          </div>
          <Button type="button" size="sm" onClick={() => void handleAdd()}>
            {tAction('add')}
          </Button>
        </div>
      )}
    </div>
  );
}

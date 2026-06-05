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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
import type { AttachmentEntityType } from '@/lib/validators/attachment';
import type { AttachmentDTO } from '@/services/attachment.service';
import { resolveAttachmentHref } from '@/lib/attachment-href';
// ADR-0021 (2026-05-26): 添付ファイル本体アップロード対応
const UPLOADABLE_ENTITY_TYPES = new Set<AttachmentEntityType>([
  'project',
  'task',
  'estimate',
  'risk',
  'retrospective',
  'knowledge',
  // 2026-06-03: memo も他資産同様にファイル本体アップロード対応 (旧「URL 添付のみ」制限を解除)
  'memo',
]);
const FILE_MAX_BYTES = 50 * 1_000_000; // 50MB SI (file-storage-pricing.ts と一致)

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
  const { showSuccess, showError } = useToast();
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
  // ADR-0021 (2026-05-26): ファイル本体アップロード state
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadEnabled = UPLOADABLE_ENTITY_TYPES.has(entityType);

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
      const msg = json.error?.message || json.error?.details?.[0]?.message || t('addFailed');
      setError(msg);
      showError('リンクの追加に失敗しました');
      return;
    }
    setNewDisplayName('');
    setNewUrl('');
    showSuccess('リンクを追加しました');
    await reload();
  }

  // ADR-0021 (2026-05-26): Pre-signed URL → PUT → finalize の 3 段階アップロード
  async function handleUpload(file: File) {
    setError('');
    if (file.size > FILE_MAX_BYTES) {
      setError(`ファイル サイズが上限 ${Math.floor(FILE_MAX_BYTES / 1_000_000)}MB を超えています`);
      showError('ファイル サイズ上限を超えています');
      return;
    }
    setUploading(true);
    try {
      // 1. Pre-signed Upload URL 発行
      const uploadRes = await withLoading(() =>
        fetch('/api/attachments/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entityType,
            entityId,
            slot,
            fileName: file.name,
            sizeBytes: file.size,
            mimeType: file.type || undefined,
          }),
        }),
      );
      if (!uploadRes.ok) {
        const j = await uploadRes.json().catch(() => ({}));
        const msg = j.error?.message ?? j.error?.code ?? 'アップロード URL の発行に失敗しました';
        setError(msg);
        showError(msg);
        return;
      }
      const upload = await uploadRes.json();
      const { uploadUrl, token, objectKey, sanitizedFileName } = upload.data;

      // 2. ブラウザから Supabase Storage へ直接 PUT (= server 経由しない)
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          // Supabase Storage の Pre-signed Upload は token をクエリ or x-upsert と共に PUT で利用。
          // createSignedUploadUrl が返す signedUrl は token をクエリに含む形式 (Supabase SDK v2 標準)。
          // 念のため Authorization も付加。
          Authorization: `Bearer ${token}`,
          'x-upsert': 'false',
        },
        body: file,
      });
      if (!putRes.ok) {
        setError('Supabase へのアップロードに失敗しました');
        showError('Supabase へのアップロードに失敗しました');
        return;
      }

      // 3. finalize で DB row + storage-guard 更新
      const finalizeRes = await fetch('/api/attachments/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityType,
          entityId,
          slot,
          objectKey,
          fileName: sanitizedFileName,
          displayName: sanitizedFileName,
          sizeBytes: file.size,
          mimeType: file.type || undefined,
        }),
      });
      if (!finalizeRes.ok) {
        const j = await finalizeRes.json().catch(() => ({}));
        const msg = j.error?.message ?? j.error?.code ?? 'finalize に失敗しました';
        setError(msg);
        showError(msg);
        return;
      }
      showSuccess('ファイルをアップロードしました (検索インデックス作成中)');
      await reload();
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t('deleteConfirm'))) return;
    const res = await withLoading(() =>
      fetch(`/api/attachments/${id}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      setError(t('deleteFailed'));
      showError('リンクの削除に失敗しました');
      return;
    }
    showSuccess('リンクを削除しました');
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
          {items.map((a) => {
            // ADR-0021 (2026-05-26): supabase 本体は /api/attachments/[id]/download に
            //   遷移して Pre-signed Download URL の 302 redirect を受ける (= 表示時に都度発行)。
            //   url 型は外部リンク URL に直接遷移。href 解決は resolveAttachmentHref に一本化。
            const href = resolveAttachmentHref(a);
            const isSupabase = a.storageProvider === 'supabase';
            const statusBadge =
              isSupabase && a.embeddingStatus === 'pending'
                ? ' (検索インデックス作成中)'
                : isSupabase && a.embeddingStatus === 'failed'
                  ? ' (インデックス作成失敗)'
                  : '';
            const sizeLabel = a.sizeBytes ? ` ${Math.ceil(a.sizeBytes / 1000).toLocaleString()}KB` : '';
            return (
              <li key={a.id} className="flex items-start gap-2 rounded border px-2 py-1 text-sm">
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 wrap-anywhere text-info hover:underline"
                  title={a.url}
                >
                  {isSupabase ? '📎 ' : ''}
                  {a.displayName}
                  {sizeLabel && <span className="ml-1 text-xs text-muted-foreground">{sizeLabel}</span>}
                  {statusBadge && <span className="ml-1 text-xs text-muted-foreground">{statusBadge}</span>}
                </a>
                {canEdit && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-destructive"
                    onClick={() => handleDelete(a.id)}
                  >
                    {tAction('delete')}
                  </Button>
                )}
              </li>
            );
          })}
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

      {/* ADR-0021 (2026-05-26): ファイル本体アップロード (Pre-signed URL 経由) */}
      {canEdit && uploadEnabled && (
        <div className="flex items-center gap-2 rounded border bg-muted p-2 text-sm">
          <Label htmlFor={`attachment-upload-${entityId}`} className="text-xs">
            ファイルをアップロード (50MB 上限)
          </Label>
          <input
            ref={fileInputRef}
            id={`attachment-upload-${entityId}`}
            type="file"
            disabled={uploading}
            className="text-xs"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleUpload(f);
            }}
          />
          {uploading && <span className="text-xs text-muted-foreground">アップロード中…</span>}
        </div>
      )}
    </div>
  );
}

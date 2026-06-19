'use client';

/**
 * AssetLinkSection (v1.3.0 資産導線機能):
 *
 *   Risk / Issue / Knowledge / Retrospective / Memo の 5 資産間で「既存 ↔ 既存」を結ぶ
 *   汎用手動リンクの表示・追加・解除セクション。GET/POST /api/asset-links、
 *   DELETE /api/asset-links/:linkId、GET /api/asset-links/candidates を叩く。
 *
 *   昇華リンク (promotion-badge-list.tsx) とは別物であることを示すため、視覚的に区別する
 *   (本セクションは info 系の配色、昇華は warning 系)。
 *
 *   表示条件:
 *     - 「リンクを追加」ボタンは isPublic (現在開いている資産自身が visibility='public') の
 *       場合のみ表示する。リンク対象候補もサーバ側で公開可視のみに絞られる (defense-in-depth)。
 *     - 解除ボタンはリンク作成者本人のみに表示する (DELETE API が作成者のみ許可するため)。
 */

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
import { LINKABLE_ENTITY_TYPES } from '@/lib/validators/asset-link';
import type { LinkableEntityType } from '@/lib/validators/asset-link';

type LinkedEntitySummary = {
  entityType: LinkableEntityType;
  entityId: string;
  title: string | null;
  conductedDate: string | null;
  visibility: string;
};

type AssetLinkSummary = {
  linkId: string;
  createdAt: string;
  createdBy: string;
  entity: LinkedEntitySummary;
};

type Props = {
  entityType: LinkableEntityType;
  entityId: string;
  /** 現在開いている資産自身が公開済みか。draft の場合「リンクを追加」ボタンを出さない。 */
  isPublic: boolean;
};

const TYPE_LABEL_KEYS: Record<LinkableEntityType, string> = {
  risk: 'typeRisk',
  issue: 'typeIssue',
  knowledge: 'typeKnowledge',
  retrospective: 'typeRetrospective',
  memo: 'typeMemo',
};

export function AssetLinkSection({ entityType, entityId, isPublic }: Props) {
  const t = useTranslations('assetLink');
  const session = useSession();
  const currentUserId = session.data?.user?.id;
  const { withLoading } = useLoading();
  const { showSuccessKey, showErrorKey } = useToast();

  const [links, setLinks] = useState<AssetLinkSummary[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickType, setPickType] = useState<LinkableEntityType>(entityType);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<LinkedEntitySummary[]>([]);
  const [searching, setSearching] = useState(false);

  function entityLabel(entity: LinkedEntitySummary): string {
    if (entity.entityType === 'retrospective') {
      return t('retrospectiveLabel', { date: entity.conductedDate ?? '-' });
    }
    return entity.title ?? '-';
  }

  async function reload() {
    const res = await fetch(`/api/asset-links?entityType=${entityType}&entityId=${entityId}`);
    const json = res.ok ? await res.json() : { data: [] };
    setLinks(json.data ?? []);
  }

  // 初回 mount + entity 変更時にリンク一覧をサーバから同期取得する。
  // 外部 API 同期のため react-hooks/set-state-in-effect 例外規定の対象 (comment-section.tsx と同様)。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    // entityType/entityId は呼出元から固定的に渡される (ダイアログ切替時は別 mount になる想定)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, entityId]);

  useEffect(() => {
    if (!pickerOpen) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSearching(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ entityType: pickType, query });
      if (pickType === entityType) params.set('excludeEntityId', entityId);
      fetch(`/api/asset-links/candidates?${params.toString()}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((json: { data?: LinkedEntitySummary[] } | null) => setCandidates(json?.data ?? []))
        .catch(() => setCandidates([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [pickerOpen, pickType, query, entityType, entityId]);

  function openPicker() {
    setPickType(entityType);
    setQuery('');
    setCandidates([]);
    setPickerOpen(true);
  }

  async function handleSelect(candidate: LinkedEntitySummary) {
    const res = await withLoading(() =>
      fetch('/api/asset-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromEntityType: entityType,
          fromEntityId: entityId,
          toEntityType: candidate.entityType,
          toEntityId: candidate.entityId,
        }),
      }),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const code = json.error?.code;
      const key =
        code === 'ALREADY_LINKED' ? 'assetLink.alreadyLinked'
          : code === 'SELF_LINK_FORBIDDEN' ? 'assetLink.selfLinkForbidden'
            : 'assetLink.linkFailed';
      showErrorKey(key);
      return;
    }
    showSuccessKey('assetLink.linkSuccess');
    setPickerOpen(false);
    await reload();
  }

  async function handleUnlink(linkId: string) {
    if (!confirm(t('unlinkConfirm'))) return;
    const res = await withLoading(() => fetch(`/api/asset-links/${linkId}`, { method: 'DELETE' }));
    if (!res.ok) {
      showErrorKey('assetLink.unlinkFailed');
      return;
    }
    showSuccessKey('assetLink.unlinkSuccess');
    await reload();
  }

  if (links === null) return null;

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('sectionTitle', { count: links.length })}</h3>
        {isPublic && (
          <Button type="button" variant="outline" size="sm" onClick={openPicker}>
            {t('addButton')}
          </Button>
        )}
      </div>
      {links.length === 0 ? (
        <p className="rounded border border-dashed border-info/40 p-3 text-sm text-muted-foreground">
          {t('noLinks')}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {links.map((link) => (
            <li
              key={link.linkId}
              className="flex max-w-full items-center gap-1.5 overflow-hidden rounded-full border border-info/40 bg-info/10 px-2.5 py-1 text-xs"
              title={entityLabel(link.entity)}
            >
              <span className="min-w-0 flex-1 truncate">{entityLabel(link.entity)}</span>
              {link.createdBy === currentUserId && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="ml-0.5 h-4 w-4 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => handleUnlink(link.linkId)}
                  title={t('unlinkButtonTitle')}
                  aria-label={t('unlinkButtonTitle')}
                >
                  <span aria-hidden>×</span>
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-w-[min(90vw,28rem)]">
          <DialogHeader>
            <DialogTitle>{t('dialogTitle')}</DialogTitle>
            <DialogDescription>{t('dialogDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <select
                value={pickType}
                onChange={(e) => setPickType(e.target.value as LinkableEntityType)}
                className={nativeSelectClass}
              >
                {LINKABLE_ENTITY_TYPES.map((type) => (
                  <option key={type} value={type}>{t(TYPE_LABEL_KEYS[type])}</option>
                ))}
              </select>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('searchPlaceholder')}
              />
            </div>
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {searching && <li className="px-2 py-1.5 text-sm text-muted-foreground">{t('searching')}</li>}
              {!searching && candidates.length === 0 && (
                <li className="px-2 py-1.5 text-sm text-muted-foreground">{t('noResults')}</li>
              )}
              {!searching && candidates.map((c) => (
                <li key={c.entityId}>
                  <button
                    type="button"
                    onClick={() => handleSelect(c)}
                    className="block w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                    title={entityLabel(c)}
                  >
                    {entityLabel(c)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

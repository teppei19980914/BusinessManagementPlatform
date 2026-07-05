'use client';

/**
 * 公開資産共有ダイアログ (v1.5.0)
 *
 * 使い方:
 *   <ShareAssetDialog
 *     entityType="knowledge"
 *     entityId={knowledge.id}
 *     assetTitle={knowledge.title}
 *     open={shareOpen}
 *     onOpenChange={setShareOpen}
 *   />
 *
 * 動作:
 *   - open 時にテナントメンバー一覧を /api/mention-candidates から取得
 *   - 送信者本人は一覧に表示されない (useSession で取得した currentUserId を除外)
 *   - チェックボックスでメンバーを複数選択
 *   - 確定ボタンで POST /api/assets/share を呼び出し
 */

import { useState, useEffect, useMemo } from 'react';
import { useSession } from 'next-auth/react';
import { SearchIcon, SendIcon } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';

type ShareEntityType = 'knowledge' | 'risk' | 'issue' | 'retrospective' | 'memo';

type User = { id: string; name: string; email: string };

type Props = {
  entityType: ShareEntityType;
  entityId: string;
  assetTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ShareAssetDialog({ entityType, entityId, assetTitle, open, onOpenChange }: Props) {
  const { withLoading } = useLoading();
  const { showSuccessKey, showErrorKey } = useToast();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const [users, setUsers] = useState<User[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  // ダイアログが開くたびにメンバー一覧を取得し、選択状態をリセット
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ダイアログ open 時の選択状態リセット (外部ストアなし)
    setSelectedIds(new Set());
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuery('');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    const params = new URLSearchParams({ entityType, entityId, context: 'cross_list' });
    void fetch(`/api/mention-candidates?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { data: { users: User[] } } | null) => {
        setUsers(json?.data?.users ?? []);
      })
      .finally(() => setLoading(false));
  }, [open, entityType, entityId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users
      .filter((u) => u.id !== currentUserId)
      .filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }, [users, query, currentUserId]);

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleShare() {
    if (selectedIds.size === 0) return;
    await withLoading(async () => {
      const res = await fetch('/api/assets/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityType,
          entityId,
          recipientUserIds: Array.from(selectedIds),
        }),
      });
      const json = (await res.json()) as { data?: { count: number }; error?: { message: string } };
      if (!res.ok) {
        showErrorKey('asset.share.toastFailed');
        return;
      }
      const count = json.data?.count ?? 0;
      if (count > 0) {
        showSuccessKey('asset.share.toastSuccess', { count });
      } else {
        showSuccessKey('asset.share.toastNoRecipients');
      }
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>資産を共有</DialogTitle>
          <DialogDescription className="line-clamp-2 text-xs">
            「{assetTitle}」を共有するメンバーを選択してください
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" aria-hidden />
          <Input
            className="pl-8 h-8 text-sm"
            placeholder="名前・メールで絞り込み"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 rounded-md border border-input">
          {loading && (
            <p className="text-sm text-muted-foreground text-center py-6">読み込み中…</p>
          )}
          {!loading && filtered.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-6">
              {query ? '一致するメンバーがいません' : 'メンバーがいません'}
            </p>
          )}
          {!loading && filtered.map((u) => (
            <label
              key={u.id}
              className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <input
                type="checkbox"
                className="size-4 rounded border-input accent-primary"
                checked={selectedIds.has(u.id)}
                onChange={() => toggle(u.id)}
              />
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium truncate">{u.name}</span>
                <span className="block text-xs text-muted-foreground truncate">{u.email}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs text-muted-foreground">
            {selectedIds.size > 0 ? `${selectedIds.size}人を選択中` : '未選択'}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              キャンセル
            </Button>
            <Button
              size="sm"
              disabled={selectedIds.size === 0}
              onClick={handleShare}
            >
              <SendIcon className="size-3.5 mr-1" aria-hidden />
              共有
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

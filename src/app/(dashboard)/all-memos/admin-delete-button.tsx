'use client';

/**
 * 全メモ画面で admin 向けに表示する削除ボタン (モデレーション用途)。
 *
 * feat/all-list-section-unification (2026-05-24):
 *   従来 all-memos-client.tsx 内に handleAdminDelete + `<Button>` が直書きされていたが、
 *   他 4 画面 (knowledge / risks / retrospectives) の Admin{Entity}DeleteButton 規約に揃えるため
 *   ここに抽出。
 *
 * 認可:
 *   - public memo に限り admin が削除可 (feat/crud-permission-redesign 2026-05-20)
 *   - private memo はそもそも本人以外参照不可なので本ボタンも到達しない
 *   - 自分の memo は /memos 個人画面で削除する想定のため、呼出側で !isMine 条件を付ける
 */

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';

export function AdminMemoDeleteButton({
  memoId,
  label,
}: {
  memoId: string;
  label: string;
}) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();
  const tAction = useTranslations('action');
  const tCommon = useTranslations('common');
  const tMemo = useTranslations('memo');
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-destructive hover:text-destructive"
      title={tCommon('adminDeleteTitle', { label })}
      aria-label={tAction('delete')}
      onClick={async () => {
        if (!confirm(tCommon('adminDeleteConfirm', { label }))) return;
        const res = await withLoading(() =>
          fetch(`/api/memos/${memoId}`, { method: 'DELETE' }),
        );
        if (!res.ok) {
          showError(tMemo('deleteFailed'));
          return;
        }
        showSuccess(tMemo('deleteSuccess'));
        router.refresh();
      }}
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}

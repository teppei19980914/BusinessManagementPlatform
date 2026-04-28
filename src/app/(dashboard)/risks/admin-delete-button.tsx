'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLoading } from '@/components/loading-overlay';

/**
 * 全リスク/課題画面で admin 向けに表示する削除ボタン。
 * 既存の /api/projects/[projectId]/risks/[riskId] DELETE を叩く (admin は
 * checkProjectPermission を通過するため権限問題なし)。
 *
 * サーバコンポーネント (/risks/page.tsx) 内のテーブル行に埋め込む前提で、
 * 必要最小限のクライアント境界。
 */
export function AdminRiskDeleteButton({
  projectId,
  riskId,
  label,
}: {
  projectId: string;
  riskId: string;
  label: string;
}) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const tAction = useTranslations('action');
  const tCommon = useTranslations('common');
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
          fetch(`/api/projects/${projectId}/risks/${riskId}`, { method: 'DELETE' }),
        );
        if (!res.ok) {
          alert(tCommon('deleteFailed'));
          return;
        }
        router.refresh();
      }}
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}

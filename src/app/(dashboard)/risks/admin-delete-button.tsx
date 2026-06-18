'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';

/**
 * 全リスク/課題画面で admin 向けに表示する削除ボタン。
 * feat/crud-permission-redesign (2026-05-20): 横断 DELETE 専用ルート /api/risks/[riskId] を叩く。
 *   旧実装は project 経路 (/api/projects/[id]/risks/[riskId] DELETE) を兼用していたが、
 *   一覧経路と横断経路で admin の削除権限を分けるため独立ルートに分離。
 *
 * サーバコンポーネント (/risks/page.tsx) 内のテーブル行に埋め込む前提で、
 * 必要最小限のクライアント境界。
 */
export function AdminRiskDeleteButton({
  riskId,
  label,
}: {
  riskId: string;
  label: string;
}) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const { showSuccessKey, showErrorKey } = useToast();
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
          fetch(`/api/risks/${riskId}`, { method: 'DELETE' }),
        );
        if (!res.ok) {
          showErrorKey('risk.toastAdminDeleteFailed');
          return;
        }
        showSuccessKey('risk.toastAdminDeleteSuccess');
        router.refresh();
      }}
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}

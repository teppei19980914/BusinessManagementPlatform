'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';

/**
 * 全振り返り画面で admin 向けに表示する削除ボタン。
 * feat/crud-permission-redesign (2026-05-20): 横断 DELETE 専用ルート /api/retrospectives/[retroId] を叩く。
 *   旧実装は project 経路を兼用していたが、一覧経路と横断経路で admin 削除権限を分けるため独立ルートに分離。
 *
 * 論理削除 (deletedAt セット) のため、同一テーブルを参照する
 * プロジェクト詳細「振り返り一覧」にも即座に反映される。
 */
export function AdminRetrospectiveDeleteButton({
  retroId,
  label,
}: {
  retroId: string;
  label: string;
}) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();
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
        if (!confirm(tCommon('adminDeleteConfirmRetrospective', { date: label }))) return;
        const res = await withLoading(() =>
          fetch(`/api/retrospectives/${retroId}`, { method: 'DELETE' }),
        );
        if (!res.ok) {
          showError('振り返りの削除に失敗しました');
          return;
        }
        showSuccess('振り返りを削除しました');
        router.refresh();
      }}
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}

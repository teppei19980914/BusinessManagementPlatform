'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';

/**
 * 全ナレッジ画面で admin 向けに表示する削除ボタン (2026-04-24 新設)。
 *
 * 既存の /api/knowledge/[knowledgeId] DELETE を叩く (作成者本人 OR admin を service 層で enforce)。
 * 論理削除 (deletedAt セット) のため、同一テーブルを参照するプロジェクト詳細
 * 「ナレッジ一覧」にも即座に反映される。
 */
export function AdminKnowledgeDeleteButton({
  knowledgeId,
  label,
}: {
  knowledgeId: string;
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
        if (!confirm(tCommon('adminDeleteConfirm', { label }))) return;
        const res = await withLoading(() =>
          fetch(`/api/knowledge/${knowledgeId}`, { method: 'DELETE' }),
        );
        if (!res.ok) {
          showError('ナレッジの削除に失敗しました');
          return;
        }
        showSuccess('ナレッジを削除しました');
        router.refresh();
      }}
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}

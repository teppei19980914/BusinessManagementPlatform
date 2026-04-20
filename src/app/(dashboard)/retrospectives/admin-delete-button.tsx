'use client';

import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLoading } from '@/components/loading-overlay';

/**
 * 全振り返り画面で admin 向けに表示する削除ボタン。
 * 既存の /api/projects/[projectId]/retrospectives/[retroId] DELETE を叩く。
 *
 * 論理削除 (deletedAt セット) のため、同一テーブルを参照する
 * プロジェクト詳細「振り返り一覧」にも即座に反映される。
 */
export function AdminRetrospectiveDeleteButton({
  projectId,
  retroId,
  label,
}: {
  projectId: string;
  retroId: string;
  label: string;
}) {
  const router = useRouter();
  const { withLoading } = useLoading();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-destructive hover:text-destructive"
      title={`「${label}」を削除 (システム管理者権限)`}
      aria-label="削除"
      onClick={async () => {
        if (!confirm(`実施日 ${label} の振り返りを削除しますか？`)) return;
        const res = await withLoading(() =>
          fetch(`/api/projects/${projectId}/retrospectives/${retroId}`, { method: 'DELETE' }),
        );
        if (!res.ok) {
          alert('削除に失敗しました');
          return;
        }
        router.refresh();
      }}
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}

'use client';

/**
 * テナント削除ボタン (P-A / 2026-05-08)
 *
 * super_admin がテナントを論理削除するためのクライアントコンポーネント。
 *
 * UI フロー:
 *   1. 「テナントを削除」ボタン押下 → 確認ダイアログを表示
 *   2. **テナント名を再入力** させて誤操作を防止 (= 取消困難な操作)
 *   3. 一致したら DELETE リクエスト送信
 *   4. 成功時: super_admin テナント一覧に戻す
 *   5. 失敗時: エラーメッセージ表示
 *
 * 認可: super_admin のみ (server side で再検証)
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';

type Props = {
  tenantId: string;
  tenantName: string;
};

export function TenantDeleteButton({ tenantId, tenantName }: Props) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();

  const [isOpen, setIsOpen] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');
  const [error, setError] = useState('');

  // テナント名と完全一致した時のみ削除実行を有効化
  const canDelete = confirmInput === tenantName;

  async function handleDelete() {
    if (!canDelete) return;
    setError('');

    const res = await withLoading(() =>
      fetch(`/api/admin/super/tenants/${tenantId}`, {
        method: 'DELETE',
      }),
    );

    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const code = json?.error?.code as string | undefined;
      const message = json?.error?.message as string | undefined;

      if (code === 'MANAGEMENT_TENANT_FORBIDDEN') {
        setError('管理テナント (運営内部) は削除できません。');
      } else if (code === 'ALREADY_DELETED') {
        setError('このテナントは既に削除済みです。');
      } else if (code === 'TENANT_NOT_FOUND') {
        setError('テナントが見つかりません。');
      } else if (code === 'FORBIDDEN') {
        setError('削除権限がありません (super_admin のみ実行可能)。');
      } else {
        setError(message ?? '削除に失敗しました。時間をおいて再度お試しください。');
      }
      showError('テナント削除に失敗しました');
      return;
    }

    showSuccess(`テナント「${tenantName}」を削除しました`);
    setIsOpen(false);
    // 一覧に戻る (super_admin の listAllTenants は deletedAt: null フィルタで非表示になる)
    router.push('/admin/super/tenants');
    router.refresh();
  }

  function handleClose() {
    setIsOpen(false);
    setConfirmInput('');
    setError('');
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
        else setIsOpen(true);
      }}
    >
      <DialogTrigger className="inline-flex items-center justify-center rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground shadow-xs hover:bg-destructive/90">
        🗑️ テナントを削除
      </DialogTrigger>
      <DialogContent className="max-w-[min(90vw,32rem)]">
        <DialogHeader>
          <DialogTitle>テナント削除の確認</DialogTitle>
          <DialogDescription>
            この操作は取り消しできません (本 PR では復元機能なし)。テナントを削除すると、
            配下のユーザはログイン不可となり、すべての業務データが参照できなくなります。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <p>
              <strong>削除対象:</strong> {tenantName}
            </p>
            <p className="mt-1 text-muted-foreground">
              users / projects / customers / knowledges / risksIssues /
              retrospectives / memos / stakeholders / comments / attachments を
              論理削除し、テナント自体も論理削除します。
              api_call_logs / 月次履歴 / 監査ログは物理保持されます。
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tenant-name-confirm">
              削除を確定するには、テナント名「<strong>{tenantName}</strong>」を入力してください
            </Label>
            <Input
              id="tenant-name-confirm"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={tenantName}
              autoComplete="off"
            />
          </div>

          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={handleClose}>
            キャンセル
          </Button>
          <Button
            variant="destructive"
            disabled={!canDelete}
            onClick={handleDelete}
          >
            削除を実行
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

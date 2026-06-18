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
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('superAdmin');
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
        setError(t('tenantDeleteErrorManagement'));
      } else if (code === 'ALREADY_DELETED') {
        setError(t('tenantDeleteErrorAlreadyDeleted'));
      } else if (code === 'TENANT_NOT_FOUND') {
        setError(t('tenantDeleteErrorNotFound'));
      } else if (code === 'FORBIDDEN') {
        setError(t('tenantDeleteErrorForbidden'));
      } else {
        setError(message ?? t('tenantDeleteErrorDefault'));
      }
      showError(t('tenantDeleteToastFailed'));
      return;
    }

    showSuccess(t('tenantDeleteToastSuccess', { name: tenantName }));
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
        {t('tenantDeleteButton')}
      </DialogTrigger>
      <DialogContent className="max-w-[min(90vw,32rem)]">
        <DialogHeader>
          <DialogTitle>{t('tenantDeleteDialogTitle')}</DialogTitle>
          <DialogDescription>
            {t('tenantDeleteDialogBody')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* P-B (2026-05-08): 運営者の手動運用としてメール事前連絡が必要であることを明示 */}
          <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/40 dark:bg-amber-950/30">
            <p className="font-semibold text-amber-900 dark:text-amber-200">
              {t('tenantDeleteWarningTitle')}
            </p>
            <p className="mt-1 text-amber-900 dark:text-amber-200">
              {t.rich('tenantDeleteWarningBody', { strong: (chunks) => <strong>{chunks}</strong> })}
            </p>
          </div>

          <div className="rounded border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <p>
              {t.rich('tenantDeleteTargetLabel', {
                name: tenantName,
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
            <p className="mt-1 text-muted-foreground">
              {t('tenantDeleteScopeBody')}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tenant-name-confirm">
              {t.rich('tenantDeleteConfirmInputLabel', {
                name: tenantName,
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
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
            {t('tenantDeleteCancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={!canDelete}
            onClick={handleDelete}
          >
            {t('tenantDeleteSubmit')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

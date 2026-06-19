'use client';

/**
 * テナント read-only 強制移行 (suspend) / 解除 (resume) ボタン (PR #372 / 2026-05-14)
 *
 * super_admin がテナントを read-only モードへ強制移行する / 解除するための
 * クライアントコンポーネント。tenant.suspendedAt の状態に応じて表示が切り替わる。
 *
 * UI フロー:
 *   - suspendedAt=null (= 通常運用): 「⏸ テナントを停止」ボタン表示
 *     → ダイアログで停止理由を選択させて POST .../suspend
 *   - suspendedAt!=null (= 停止中): 停止情報を表示 + 「▶ 停止を解除」ボタン
 *     → ダイアログで確認させて POST .../resume
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
import { Label } from '@/components/ui/label';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';

type Props = {
  tenantId: string;
  tenantName: string;
  /** 現在の停止状態 (null = 通常運用、Date = 停止中) */
  suspendedAt: string | null;
  /** 停止理由コード (停止中のときに表示用) */
  suspendReason: string | null;
};

const REASON_LABEL_KEYS: Record<string, string> = {
  payment_delinquent: 'tenantSuspendReasonPayment',
  tos_violation: 'tenantSuspendReasonTosViolation',
  other: 'tenantSuspendReasonOther',
};

export function TenantSuspendButton({
  tenantId,
  tenantName,
  suspendedAt,
  suspendReason,
}: Props) {
  if (suspendedAt == null) {
    return <SuspendDialog tenantId={tenantId} tenantName={tenantName} />;
  }
  return (
    <ResumeDialog
      tenantId={tenantId}
      tenantName={tenantName}
      suspendedAt={suspendedAt}
      suspendReason={suspendReason}
    />
  );
}

function SuspendDialog({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const router = useRouter();
  const t = useTranslations('superAdmin');
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();

  const [isOpen, setIsOpen] = useState(false);
  const [reason, setReason] = useState<'payment_delinquent' | 'tos_violation' | 'other'>(
    'payment_delinquent',
  );
  const [error, setError] = useState('');

  async function handleSuspend() {
    setError('');

    const res = await withLoading(() =>
      fetch(`/api/admin/super/tenants/${tenantId}/suspend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      }),
    );

    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const code = json?.error?.code as string | undefined;
      const message = json?.error?.message as string | undefined;

      if (code === 'MANAGEMENT_TENANT_FORBIDDEN') {
        setError(t('tenantSuspendErrorManagement'));
      } else if (code === 'TENANT_DELETED') {
        setError(t('tenantSuspendErrorTenantDeleted'));
      } else if (code === 'ALREADY_SUSPENDED') {
        setError(t('tenantSuspendErrorAlreadySuspended'));
      } else if (code === 'TENANT_NOT_FOUND') {
        setError(t('tenantSuspendErrorNotFound'));
      } else if (code === 'FORBIDDEN') {
        setError(t('tenantSuspendErrorForbidden'));
      } else {
        setError(message ?? t('tenantSuspendErrorDefault'));
      }
      showError(t('tenantSuspendToastFailed'));
      return;
    }

    showSuccess(t('tenantSuspendToastSuccess', { name: tenantName }));
    setIsOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          setIsOpen(false);
          setError('');
        } else {
          setIsOpen(true);
        }
      }}
    >
      <DialogTrigger className="inline-flex items-center justify-center rounded-md border border-amber-500 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 shadow-xs hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
        {t('tenantSuspendButton')}
      </DialogTrigger>
      <DialogContent className="max-w-[min(90vw,32rem)]">
        <DialogHeader>
          <DialogTitle>{t('tenantSuspendDialogTitle')}</DialogTitle>
          <DialogDescription>
            {t('tenantSuspendDialogBody')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/40 dark:bg-amber-950/30">
            <p className="font-semibold text-amber-900 dark:text-amber-200">
              {t('tenantSuspendWarningTitle')}
            </p>
            <p className="mt-1 text-amber-900 dark:text-amber-200">
              {t.rich('tenantSuspendWarningBody', { strong: (chunks) => <strong>{chunks}</strong> })}
              <code className="text-xs">docs/operations/PAYMENT_DELINQUENCY_SOP.md §3</code>
            </p>
          </div>

          <div className="rounded border border-amber-300/30 bg-amber-50/30 p-3 text-sm">
            <p>
              {t.rich('tenantSuspendTargetLabel', { name: tenantName, strong: (chunks) => <strong>{chunks}</strong> })}
            </p>
            <p className="mt-1 text-muted-foreground">
              {t('tenantSuspendScopeBody')}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="suspend-reason">{t('tenantSuspendReasonLabel')}</Label>
            <select
              id="suspend-reason"
              value={reason}
              onChange={(e) =>
                setReason(e.target.value as 'payment_delinquent' | 'tos_violation' | 'other')
              }
              className="block w-full rounded border bg-background p-2 text-sm"
            >
              {(['payment_delinquent', 'tos_violation', 'other'] as const).map((r) => (
                <option key={r} value={r}>
                  {t(REASON_LABEL_KEYS[r])}
                </option>
              ))}
            </select>
          </div>

          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setIsOpen(false);
              setError('');
            }}
          >
            {t('tenantSuspendCancel')}
          </Button>
          <Button onClick={handleSuspend}>{t('tenantSuspendSubmit')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResumeDialog({
  tenantId,
  tenantName,
  suspendedAt,
  suspendReason,
}: {
  tenantId: string;
  tenantName: string;
  suspendedAt: string;
  suspendReason: string | null;
}) {
  const router = useRouter();
  const t = useTranslations('superAdmin');
  const { withLoading } = useLoading();
  const { showSuccess, showError } = useToast();

  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState('');

  async function handleResume() {
    setError('');

    const res = await withLoading(() =>
      fetch(`/api/admin/super/tenants/${tenantId}/resume`, {
        method: 'POST',
      }),
    );

    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const code = json?.error?.code as string | undefined;
      const message = json?.error?.message as string | undefined;

      if (code === 'TENANT_DELETED') {
        setError(t('tenantResumeErrorTenantDeleted'));
      } else if (code === 'NOT_SUSPENDED') {
        setError(t('tenantResumeErrorNotSuspended'));
      } else if (code === 'TENANT_NOT_FOUND') {
        setError(t('tenantResumeErrorNotFound'));
      } else if (code === 'FORBIDDEN') {
        setError(t('tenantResumeErrorForbidden'));
      } else {
        setError(message ?? t('tenantResumeErrorDefault'));
      }
      showError(t('tenantResumeToastFailed'));
      return;
    }

    showSuccess(t('tenantResumeToastSuccess', { name: tenantName }));
    setIsOpen(false);
    router.refresh();
  }

  const suspendedAtLocal = new Date(suspendedAt).toLocaleString('ja-JP');
  const reasonLabel = suspendReason
    ? (REASON_LABEL_KEYS[suspendReason] ? t(REASON_LABEL_KEYS[suspendReason]) : suspendReason)
    : t('tenantResumeUnknownReason');

  return (
    <div className="space-y-3 rounded border border-amber-500 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950/30">
      <p className="font-semibold text-amber-900 dark:text-amber-200">
        {t('tenantResumeBannerTitle')}
      </p>
      <ul className="ml-4 list-disc space-y-1 text-amber-900 dark:text-amber-200">
        <li>{t('tenantResumeBannerSuspendedAt', { value: suspendedAtLocal })}</li>
        <li>{t('tenantResumeBannerSuspendedReason', { value: reasonLabel })}</li>
        <li>{t('tenantResumeBannerStatus')}</li>
      </ul>

      <Dialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsOpen(false);
            setError('');
          } else {
            setIsOpen(true);
          }
        }}
      >
        <DialogTrigger className="inline-flex items-center justify-center rounded-md border border-amber-700 bg-white px-4 py-2 text-sm font-medium text-amber-900 shadow-xs hover:bg-accent dark:bg-amber-900/40 dark:text-amber-200">
          {t('tenantResumeButton')}
        </DialogTrigger>
        <DialogContent className="max-w-[min(90vw,32rem)]">
          <DialogHeader>
            <DialogTitle>{t('tenantResumeDialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('tenantResumeDialogBody')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded border bg-muted/30 p-3 text-sm">
              <p>
                {t.rich('tenantResumeTargetLabel', { name: tenantName, strong: (chunks) => <strong>{chunks}</strong> })}
              </p>
              <p className="mt-1 text-muted-foreground">
                {t('tenantResumeTargetDetail', { reason: reasonLabel, at: suspendedAtLocal })}
              </p>
            </div>

            <p className="text-xs text-muted-foreground">
              {t('tenantResumeNote')}
            </p>

            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setIsOpen(false);
                setError('');
              }}
            >
              {t('tenantResumeCancel')}
            </Button>
            <Button onClick={handleResume}>{t('tenantResumeSubmit')}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

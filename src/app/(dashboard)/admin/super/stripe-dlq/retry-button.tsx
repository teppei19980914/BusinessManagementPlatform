'use client';

/**
 * Stripe DLQ 再投入ボタン (PR-V7 #6 / 2026-05-19)
 *
 * server component の page.tsx から分離した client component。
 * POST /api/admin/super/stripe-dlq/{webhook|usage}/[id]/retry を叩いて
 * 成功時に router.refresh() で一覧を reload する。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useToast } from '@/components/toast-provider';
import { Button } from '@/components/ui/button';

export type StripeDlqRetryButtonProps = {
  kind: 'webhook' | 'usage';
  id: string;
  label: string;
};

export function StripeDlqRetryButton({ kind, id, label }: StripeDlqRetryButtonProps) {
  const router = useRouter();
  const t = useTranslations('superAdmin');
  const { showSuccess, showError } = useToast();
  const [submitting, setSubmitting] = useState(false);

  const handleClick = async () => {
    const confirmed = window.confirm(
      kind === 'webhook' ? t('stripeDlqRetryConfirmWebhook') : t('stripeDlqRetryConfirmUsage'),
    );
    if (!confirmed) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/super/stripe-dlq/${kind}/${id}/retry`, {
        method: 'POST',
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        showError(json?.error?.message ?? t('stripeDlqRetryErrorDefault'));
        return;
      }
      showSuccess(t('stripeDlqRetryToastSuccess'));
      router.refresh();
    } catch {
      showError(t('stripeDlqRetryNetworkError'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={handleClick}
      disabled={submitting}
    >
      {submitting ? t('stripeDlqRetryProcessing') : label}
    </Button>
  );
}

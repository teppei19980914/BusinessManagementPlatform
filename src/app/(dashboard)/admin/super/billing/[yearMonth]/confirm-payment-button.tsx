'use client';

/**
 * 銀行振込手動消込ボタン (PR-V7a / 2026-05-19)
 *
 * super_admin が invoice / bank_transfer 払いの pending 行を「入金確認済」に
 * 1 click で遷移させるための client component。
 *
 * - confirm dialog で誤操作防止
 * - 入金日 (paidAt) の override は prompt で任意入力 (= 振込日を遡って指定するケース)
 * - 成功後 router.refresh() で一覧 reload
 *
 * 関連: POST /api/admin/super/billing/[id]/confirm-payment
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast-provider';
import { Button } from '@/components/ui/button';

export type ConfirmPaymentButtonProps = {
  billingHistoryId: string;
  tenantName: string;
};

export function ConfirmPaymentButton({
  billingHistoryId,
  tenantName,
}: ConfirmPaymentButtonProps) {
  const router = useRouter();
  const { showSuccess, showError } = useToast();
  const [submitting, setSubmitting] = useState(false);

  const handleClick = async () => {
    const confirmMsg
      = `「${tenantName}」の請求を入金確認済 (paid) にしますか?\n\n`
      + 'OK で「今日付け」、Cancel で操作中止。\n'
      + '（過去日に遡って消込する場合は別画面 / SQL で対応予定）';
    if (!window.confirm(confirmMsg)) return;

    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/admin/super/billing/${billingHistoryId}/confirm-payment`,
        { method: 'POST' },
      );
      const json = (await res.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      if (!res.ok) {
        showError(json?.error?.message ?? '消込に失敗しました');
        return;
      }
      showSuccess('入金確認済に更新しました');
      router.refresh();
    } catch {
      showError('通信エラー');
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
      {submitting ? '処理中…' : '入金確認'}
    </Button>
  );
}

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

const REASON_LABELS: Record<string, string> = {
  payment_delinquent: '支払い滞納 (PAYMENT_DELINQUENCY_SOP §3 フェーズ2)',
  tos_violation: '利用規約違反',
  other: 'その他 (営業判断)',
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
        setError('管理テナント (運営内部) は停止できません。');
      } else if (code === 'TENANT_DELETED') {
        setError('このテナントは既に削除済みのため停止できません。');
      } else if (code === 'ALREADY_SUSPENDED') {
        setError('このテナントは既に停止中です。画面を再読込してください。');
      } else if (code === 'TENANT_NOT_FOUND') {
        setError('テナントが見つかりません。');
      } else if (code === 'FORBIDDEN') {
        setError('停止権限がありません (super_admin のみ実行可能)。');
      } else {
        setError(message ?? '停止操作に失敗しました。時間をおいて再度お試しください。');
      }
      showError('テナント停止に失敗しました');
      return;
    }

    showSuccess(`テナント「${tenantName}」を停止しました (read-only モード)`);
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
        ⏸ テナントを停止 (read-only)
      </DialogTrigger>
      <DialogContent className="max-w-[min(90vw,32rem)]">
        <DialogHeader>
          <DialogTitle>テナント停止の確認</DialogTitle>
          <DialogDescription>
            テナントを read-only モードへ強制移行します。停止中も閲覧は可能ですが、
            新規作成・編集・削除・提案エンジン呼出は middleware で 403 遮断されます。
            プラン変更とセルフ解約は引き続き可能です。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/40 dark:bg-amber-950/30">
            <p className="font-semibold text-amber-900 dark:text-amber-200">
              ⚠ 停止前の運用上の手順
            </p>
            <p className="mt-1 text-amber-900 dark:text-amber-200">
              停止前に <strong>テナント代表者 (請求先メール) へ停止予告メールを送信</strong> し、
              実施日について合意を取ってから本機能で停止してください。本ダイアログからは
              自動でメールは送信されません。
              詳細手順:{' '}
              <code className="text-xs">docs/operations/PAYMENT_DELINQUENCY_SOP.md §3</code>
            </p>
          </div>

          <div className="rounded border border-amber-300/30 bg-amber-50/30 p-3 text-sm">
            <p>
              <strong>停止対象:</strong> {tenantName}
            </p>
            <p className="mt-1 text-muted-foreground">
              停止すると、配下の全ユーザの tokenVersion が increment され、
              既存セッションは次リクエストで強制ログアウトされます。
              再ログイン後は middleware が write 系 HTTP method を 403 で遮断します。
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="suspend-reason">停止理由 (auditLog に記録)</Label>
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
                  {REASON_LABELS[r]}
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
            キャンセル
          </Button>
          <Button onClick={handleSuspend}>停止を実行</Button>
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
        setError('このテナントは削除済みのため再開できません。');
      } else if (code === 'NOT_SUSPENDED') {
        setError('このテナントは停止中ではありません。画面を再読込してください。');
      } else if (code === 'TENANT_NOT_FOUND') {
        setError('テナントが見つかりません。');
      } else if (code === 'FORBIDDEN') {
        setError('解除権限がありません (super_admin のみ実行可能)。');
      } else {
        setError(message ?? '解除操作に失敗しました。時間をおいて再度お試しください。');
      }
      showError('テナント解除に失敗しました');
      return;
    }

    showSuccess(`テナント「${tenantName}」の停止を解除しました`);
    setIsOpen(false);
    router.refresh();
  }

  const suspendedAtLocal = new Date(suspendedAt).toLocaleString('ja-JP');
  const reasonLabel = suspendReason
    ? (REASON_LABELS[suspendReason] ?? suspendReason)
    : '(不明)';

  return (
    <div className="space-y-3 rounded border border-amber-500 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950/30">
      <p className="font-semibold text-amber-900 dark:text-amber-200">
        ⏸ このテナントは現在 read-only モード (停止中) です
      </p>
      <ul className="ml-4 list-disc space-y-1 text-amber-900 dark:text-amber-200">
        <li>停止日時: {suspendedAtLocal}</li>
        <li>停止理由: {reasonLabel}</li>
        <li>状態: write 系 HTTP method (POST/PATCH/PUT/DELETE) は 403 遮断中</li>
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
          ▶ 停止を解除 (通常運用へ復帰)
        </DialogTrigger>
        <DialogContent className="max-w-[min(90vw,32rem)]">
          <DialogHeader>
            <DialogTitle>テナント停止解除の確認</DialogTitle>
            <DialogDescription>
              テナントを通常運用へ復帰させます。配下の全ユーザの tokenVersion が
              increment され、現在のセッションは強制ログアウトされます。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded border bg-muted/30 p-3 text-sm">
              <p>
                <strong>復帰対象:</strong> {tenantName}
              </p>
              <p className="mt-1 text-muted-foreground">
                停止理由: {reasonLabel} / 停止日時: {suspendedAtLocal}
              </p>
            </div>

            <p className="text-xs text-muted-foreground">
              入金確認 / 違反解消等の事実を確認したうえで実行してください。
              監査ログ (auditLog) に super_admin の userId と実行時刻が記録されます。
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
              キャンセル
            </Button>
            <Button onClick={handleResume}>解除を実行</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

'use client';

/**
 * 汎用「再集計」ボタン (2026-05-14)
 *
 * super_admin / テナント管理者のダッシュボード画面で「DB 容量」「API 利用量」を
 * 即時再集計するためのトリガー。POST endpoint を叩き、成功したら router.refresh()
 * で Server Component を再実行して最新値を再描画する。
 *
 * 状態:
 *   - idle    "🔄 再集計"
 *   - pending "⏳ 集計中…" (disabled, spinner)
 *   - success "✓ 完了"   (3 秒間表示後 idle に戻る)
 *   - エラー時は idle に戻し toast でメッセージ表示
 *
 * 使い方:
 *   <RecalculateButton endpoint="/api/admin/super/recalculate-all" label="全カード再集計" />
 *
 * 関連:
 *   - API: src/app/api/admin/super/recalculate-all/route.ts 他 2 つ
 *   - 計画: docs/plans/2026-05-14_dashboard_realtime_recalc.md
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/toast-provider';
import { cn } from '@/lib/utils';

export type RecalculateButtonProps = {
  /** 呼び出し先の POST endpoint (相対 path 推奨) */
  endpoint: string;
  /** ボタンラベル (省略時は recalculate.label を使用) */
  label?: string;
  /** ボタンサイズ (デフォルト sm) */
  size?: 'xs' | 'sm' | 'default';
  /** ボタン variant (デフォルト outline) */
  variant?: 'default' | 'outline' | 'ghost' | 'secondary';
  /** 成功時に追加で実行するコールバック (任意) */
  onSuccess?: () => void;
  /** 追加 className */
  className?: string;
};

type ButtonState = 'idle' | 'pending' | 'success';

export function RecalculateButton({
  endpoint,
  label,
  size = 'sm',
  variant = 'outline',
  onSuccess,
  className,
}: RecalculateButtonProps) {
  const router = useRouter();
  const t = useTranslations('recalculate');
  const { showError, showSuccessKey } = useToast();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<ButtonState>('idle');
  const resolvedLabel = label ?? t('label');

  const handleClick = () => {
    setState('pending');
    startTransition(async () => {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const code = body?.error?.code ?? `HTTP_${res.status}`;
          const message = body?.error?.message ?? t('failedDefault');
          throw new Error(`${code}: ${message}`);
        }
        setState('success');
        showSuccessKey('recalculate.success');
        onSuccess?.();
        // RSC キャッシュを無効化して最新値で再描画
        router.refresh();
        // 3 秒後に idle に戻す
        window.setTimeout(() => setState('idle'), 3000);
      } catch (error) {
        setState('idle');
        showError(error instanceof Error ? error.message : t('failedDefault'));
      }
    });
  };

  const isBusy = isPending || state === 'pending';
  const displayLabel = isBusy
    ? t('inProgress')
    : state === 'success'
      ? t('done')
      : `🔄 ${resolvedLabel}`;

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      disabled={isBusy}
      onClick={handleClick}
      aria-busy={isBusy}
      className={cn(className)}
      title={t('buttonTitle', { label: resolvedLabel })}
    >
      {displayLabel}
    </Button>
  );
}

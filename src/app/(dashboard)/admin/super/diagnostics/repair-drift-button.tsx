'use client';

/**
 * counter drift 修復ボタン (PR-V8 / 2026-05-19)
 *
 * /admin/super/diagnostics の各 drift カードに表示するクライアントコンポーネント。
 * クリック → POST /api/admin/super/tenants/[id]/repair-api-usage → 成功時に router.refresh()。
 *
 * 確認ダイアログを必ず挟む (= counter 書き換えは破壊的操作のため誤操作防止)。
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function RepairDriftButton({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    if (
      !window.confirm(
        `テナント ${tenantId} の counter を ApiCallLog SUM で上書きします。\n\n`
        + `この操作は audit_log に記録されます。実行しますか?`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/admin/super/tenants/${tenantId}/repair-api-usage`,
          { method: 'POST' },
        );
        if (!res.ok) {
          const text = await res.text();
          setError(`修復失敗: ${res.status} ${text}`);
          return;
        }
        // 成功 → ダッシュボード再描画
        router.refresh();
      } catch (e) {
        setError(`修復失敗: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  };

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={isPending}
        className="rounded bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
      >
        {isPending ? '修復中...' : '修復する'}
      </button>
      {error && <div className="text-xs text-red-700">{error}</div>}
    </div>
  );
}

'use client';

/**
 * 自テナント counter drift 修復ボタン (PR-V8.1 / 2026-05-19)
 *
 * テナント管理者画面 (`/settings/tenant`) で drift 検知時に表示する。
 * クリック → POST /api/tenants/me/repair-api-usage → 成功時に router.refresh()。
 *
 * 確認ダイアログを必ず挟む (= counter 書き換えは破壊的操作のため誤操作防止)。
 *
 * 設計判断:
 *   ApiCallLog SUM (真値) で counter を上書きするため、表示金額が下方修正される場合がある。
 *   これは「過剰請求の解消」であり問題ない (= 真値=請求書根拠と一致させる目的)。
 *
 * 関連:
 *   - super_admin 版: src/app/(dashboard)/admin/super/diagnostics/repair-drift-button.tsx
 *   - API: src/app/api/tenants/me/repair-api-usage/route.ts
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function RepairOwnDriftButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    if (
      !window.confirm(
        '自テナントの API 呼出カウンタを ApiCallLog 集計値 (真値) で上書きします。\n\n'
        + 'この操作は監査ログに記録されます。実行しますか?',
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/tenants/me/repair-api-usage', {
          method: 'POST',
        });
        if (!res.ok) {
          const text = await res.text();
          setError(`修復失敗: ${res.status} ${text}`);
          return;
        }
        // 成功 → 画面再描画
        router.refresh();
      } catch (e) {
        setError(`修復失敗: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  };

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={isPending}
        className="rounded bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
      >
        {isPending ? '修復中...' : '不整合を修復'}
      </button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}

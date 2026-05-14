/**
 * 縮退モード起動中バナー (Q5(3) UI 可視化 / 2026-05-14)
 *
 * dashboard layout の上部に常に表示する小バナー (縮退モード起動時のみ render)。
 *   - 一般ユーザ: 「embedding が一時停止」と「テナント管理者へ相談」案内
 *   - 管理者 (admin / super_admin): 「テナント設定」リンク
 *
 * 軽量 Server Component (state なし)。aria-live なしで OK (page 遷移時に再描画)。
 */

import Link from 'next/link';
import type { SystemRole } from '@/config/master-data';

export interface DegradedModeBannerProps {
  reason: 'beginner_limit_exceeded' | 'budget_exceeded' | null;
  systemRole: SystemRole;
}

export function DegradedModeBanner({ reason, systemRole }: DegradedModeBannerProps) {
  const isAdminLike = systemRole === 'admin' || systemRole === 'super_admin';

  const headline =
    reason === 'beginner_limit_exceeded'
      ? 'Beginner プランの API 呼び出し上限に達しています'
      : reason === 'budget_exceeded'
        ? '月次予算上限に達しています'
        : 'API 呼び出しが一時停止しています';

  const detail = isAdminLike
    ? '提案機能はタグ:テキスト=5:5 で動作中。embedding 生成は停止しています。「設定 → テナント」から復活できます。'
    : '提案機能はタグ:テキスト=5:5 で動作中。embedding 生成は停止しています。早期復活が必要な場合はテナント管理者にご相談ください。';

  return (
    <div
      role="alert"
      className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm dark:bg-amber-900/30"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>
          <strong>⚠ 縮退モード起動中:</strong> {headline} — {detail}
        </p>
        {isAdminLike && (
          <Link
            href="/settings/tenant"
            className="rounded border border-amber-400 bg-white px-2 py-1 text-xs font-medium hover:bg-amber-100 dark:bg-amber-900/50 dark:hover:bg-amber-900/70"
          >
            テナント設定を開く
          </Link>
        )}
      </div>
    </div>
  );
}

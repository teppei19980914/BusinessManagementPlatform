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
  /**
   * 縮退モードの理由。ADR-0030 (2026-05-30) で Embedding 系 2 reason を追加。
   * 詳細: src/lib/degraded-error-messages.ts DegradedReason
   */
  reason:
    | 'beginner_limit_exceeded'
    | 'budget_exceeded'
    | 'embedding_beginner_limit_exceeded'
    | 'embedding_budget_exceeded'
    | null;
  systemRole: SystemRole;
}

export function DegradedModeBanner({ reason, systemRole }: DegradedModeBannerProps) {
  const isAdminLike = systemRole === 'admin' || systemRole === 'super_admin';
  const isEmbeddingReason =
    reason === 'embedding_budget_exceeded' || reason === 'embedding_beginner_limit_exceeded';

  const headline = (() => {
    switch (reason) {
      case 'beginner_limit_exceeded':
        return 'Beginner プランの LLM 呼び出し上限に達しています';
      case 'budget_exceeded':
        return 'LLM 月次予算上限に達しています';
      case 'embedding_beginner_limit_exceeded':
        return 'Beginner プランの Embedding 月次試用上限に達しています';
      case 'embedding_budget_exceeded':
        return 'Embedding 月次予算上限に達しています';
      default:
        return 'API 呼び出しが一時停止しています';
    }
  })();

  // ADR-0030 (2026-05-30): Embedding 縮退時は「新規 embedding 生成のみ停止、既存検索は継続、月初 backfill で次月補填」
  //   を明示。LLM 縮退時は従来通り提案エンジンの縮退モード重み再配分を明示。
  const detail = isEmbeddingReason
    ? isAdminLike
      ? '新規 embedding 生成のみ停止、既存 embedding でのチャット検索・提案エンジンは継続。月初 backfill で次月補填されます。「設定 → テナント → 使用量タブ」から復活できます。'
      : '新規 embedding 生成のみ停止、既存検索は継続しています。早期復活が必要な場合はテナント管理者にご相談ください。'
    : isAdminLike
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

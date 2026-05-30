/**
 * 縮退モード時のエラーメッセージをロール別に出し分けるヘルパ (Q1 / 2026-05-14)。
 *
 * 一般ユーザは「テナント管理者に相談する」導線を、テナント管理者には「テナント設定で
 * 月次予算を引き上げる / Beginner からアップグレードする」など対処手順を明示する。
 * super_admin (システム管理者) は admin と同じメッセージで足る (運営者は別経路で対応)。
 *
 * - rate_limited / llm_error: ロール非依存 (短期 rate limit / LLM 一時障害)
 * - beginner_limit_exceeded / budget_exceeded: ロールで分岐 (LLM 系、ADR-0019)
 * - embedding_beginner_limit_exceeded / embedding_budget_exceeded: ロールで分岐 (ADR-0030、Embedding 系)
 * - tenant_inactive / plan_invalid / plan_forbidden: 個別文言
 *
 * 関連:
 *   - 設計: docs/business/TENANT_AND_BILLING.md §34.14.4
 */

import type { SystemRole } from '@/config/master-data';

/**
 * 縮退モード判定理由 (withMeteredLLM の WithMeteredLLMDegraded.reason と整合)。
 */
export type DegradedReason =
  | 'rate_limited'
  | 'beginner_limit_exceeded'
  | 'budget_exceeded'
  | 'tenant_inactive'
  | 'plan_invalid'
  | 'plan_forbidden'
  // ADR-0019 (2026-05-24): 無料 featureUnit の月次 fair use limit (= 月 10,000 calls/tenant) 到達
  | 'fair_use_limit_exceeded'
  // ADR-0030 (2026-05-30): Embedding 月次予算上限 + Beginner Embedding 100 件試用上限
  | 'embedding_budget_exceeded'
  | 'embedding_beginner_limit_exceeded'
  | 'llm_error';

/**
 * ロール別のエラーメッセージを取得する。
 */
export function getDegradedMessage(
  reason: DegradedReason,
  role: SystemRole,
): string {
  const isAdminLike = role === 'admin' || role === 'super_admin';

  switch (reason) {
    case 'rate_limited':
      // 短期 rate limit はユーザ起因で個人ごとの待機が必要 (= ロール非依存)
      return 'リクエスト回数の制限を超過しました。少し待ってから再度お試しください。';

    case 'beginner_limit_exceeded':
      return isAdminLike
        ? 'Beginner プランの月間 API 呼び出し上限に達しました。設定 → テナント → プラン変更から Expert / Pro へアップグレードすると、月末まで継続利用できます。'
        : 'Beginner プランの月間 API 呼び出し上限に達しました。月末になると自動的に再開します。早期復活が必要な場合はテナント管理者へご相談ください。';

    case 'budget_exceeded':
      return isAdminLike
        ? '月次予算上限に達したため、API 呼び出しを停止しました。設定 → テナント → 月次予算上限から上限額を引き上げると、その場で再開できます。'
        : '月次予算上限に達したため、API 呼び出しを停止しました。月末になると自動的に再開します。早期復活が必要な場合はテナント管理者へご相談ください。';

    case 'tenant_inactive':
      return isAdminLike
        ? 'テナントが無効化されています。super_admin に連絡し復旧手順を確認してください。'
        : 'テナントが利用できない状態です。テナント管理者へご相談ください。';

    case 'plan_invalid':
      return isAdminLike
        ? 'テナントのプラン値が不正です。設定 → テナント → プランから有効なプランを選択してください。'
        : 'テナントのプラン設定に問題があります。テナント管理者へご相談ください。';

    case 'plan_forbidden':
      return isAdminLike
        ? 'この機能は Pro プラン限定です。設定 → テナント → プラン変更から Pro プランへアップグレードしてください。'
        : 'この機能は Pro プラン限定です。利用希望の場合はテナント管理者へご相談ください。';

    case 'fair_use_limit_exceeded':
      // ADR-0019 (2026-05-24): 無料機能 (チャット検索・資産入力等) の月次上限 (10,000 calls/tenant) 到達
      // ADR-0030 (2026-05-30): Beginner Embedding 100 件上限が先に発火するため、本 reason は safety net (= Step 3.1 を bypass するバグの際にのみ発火)
      return isAdminLike
        ? '無料機能の月間利用上限 (10,000 回/テナント) に達しました。来月になると自動的に再開します。Pro プランへのアップグレードで利用枠拡張を検討してください。'
        : '無料機能の月間利用上限に達しました。来月になると自動的に再開します。早期復活が必要な場合はテナント管理者へご相談ください。';

    case 'embedding_beginner_limit_exceeded':
      // ADR-0030 (2026-05-30): Beginner Embedding 月 100 件試用上限到達。
      //   既存 embedding でのチャット検索・類似度判定は継続。新規 embedding 生成のみ停止し、
      //   失敗分は月初 backfill cron で次月補填される (= サービス停止ではない)。
      return isAdminLike
        ? 'Beginner プランの Embedding 月間試用上限 (100 件) に達しました。新規の資産入力・チャット検索の embedding 生成のみ停止しており、既存の検索は継続しています。来月 1 日に自動再開、または Expert/Pro へのアップグレードで即時復活できます。'
        : 'Embedding 機能の試用上限に達しました。既存の検索は引き続きご利用いただけます。月末になると自動的に再開します。早期復活が必要な場合はテナント管理者へご相談ください。';

    case 'embedding_budget_exceeded':
      // ADR-0030 (2026-05-30): Expert/Pro Embedding 月次予算上限到達。
      //   設定 → テナント → 使用量タブ → Embedding 生成回数の月次予算上限を引き上げると即時復活。
      //   ブロック中も既存 embedding 検索は継続、新規 embedding は次月 backfill 補填。
      return isAdminLike
        ? 'Embedding の月次予算上限に達したため、新規 embedding 生成を停止しました。既存の embedding 検索は継続しています。設定 → テナント → 使用量タブ → Embedding 生成回数の月次予算上限を引き上げると、その場で再開できます。'
        : 'Embedding の月次予算上限に達したため、新規 embedding 生成を停止しました。既存の検索は継続利用できます。月末になると自動的に再開します。早期復活が必要な場合はテナント管理者へご相談ください。';

    case 'llm_error':
      // LLM 側の一時障害なので、ロールを問わず「時間を置いて再試行」案内
      return 'AI 処理で一時的なエラーが発生しました。少し時間を置いて再度お試しください。';
  }
}

/**
 * 工数 (workload) 表示の閾値定数 (PR #361 / 2026-05-14)
 *
 * 役割:
 *   WBS 画面で ACT (Activity) を作成・編集する際、担当者の日次工数が
 *   1 人 1 日 8 時間を超えるオーバーアサインを事前に防ぐための閾値。
 *
 * 設計判断:
 *   - 「7h 超で黄色 / 8h 超で赤色」というユーザ確定要件をそのまま定数化
 *   - 将来の調整 (例: 業界別に閾値を変える) や i18n 対応のため、サービス層 / UI 層から共通参照
 *   - Client / Server 双方から import 可能な pure module (Prisma 非依存) として配置
 *
 * 関連:
 *   - サービス: src/services/task.service.ts:previewActivityWorkload
 *   - API: src/app/api/projects/[projectId]/tasks/workload/preview/route.ts
 *   - UI: src/components/wbs/workload-preview-line.tsx
 */

/** 黄色 (warning) 閾値。これを「超える」と warning。境界値 (7.0) は ok */
export const WORKLOAD_WARN_HOURS = 7;

/** 赤色 (alert) 閾値。これを「超える」と alert。境界値 (8.0) は warning */
export const WORKLOAD_ALERT_HOURS = 8;

/** 工数レベル分類。UI 側で色付けに使用 */
export type WorkloadLevel = 'ok' | 'warning' | 'alert';

/**
 * 1 日あたりの最大工数からレベルを判定する。
 *
 * 境界条件:
 *   - 7.0 ちょうど → 'ok' (未満ではないが「超える」でもないため)
 *   - 7.01 → 'warning'
 *   - 8.0 ちょうど → 'warning'
 *   - 8.01 → 'alert'
 *
 * @param maxDailyEffort 期間内の日次工数の最大値 (時間単位)
 */
export function classifyWorkloadLevel(maxDailyEffort: number): WorkloadLevel {
  if (maxDailyEffort > WORKLOAD_ALERT_HOURS) return 'alert';
  if (maxDailyEffort > WORKLOAD_WARN_HOURS) return 'warning';
  return 'ok';
}

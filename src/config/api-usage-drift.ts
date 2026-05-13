/**
 * API 利用量 drift 警告の閾値 (2026-05-14)
 *
 * Client / Server 双方から import 可能な pure module。
 * `src/services/api-usage-recalc.service.ts` から service 関数を分離し、
 * 閾値定数のみを切り出すことで Client Component bundle に Prisma (pg) を
 * 混入させないための境界。
 */

/**
 * Tenant counter と ApiCallLog SUM の差分比率がこの値以上なら警告 chip を出す。
 * 0.05 = 5%。MVP では「請求書根拠の整合性」観点で 5% を許容上限とする。
 */
export const DRIFT_WARNING_THRESHOLD = 0.05;

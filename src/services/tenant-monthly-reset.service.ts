/**
 * Tenant 月次リセット サービス (PR #2-d / T-03 提案エンジン v2)
 *
 * 役割:
 *   1. **月初リセット**: 月初を跨いだテナントの API 呼び出しカウンタ + 課金額を 0 にリセット
 *   2. **プラン変更予約適用**: scheduledPlanChangeAt 到達テナントに scheduledNextPlan を反映
 *
 * 外部 cron (cron-job.org) で毎月 1 日 00:00 UTC に実行される (`/api/cron/tenant-monthly-reset`)。
 *
 * 設計判断:
 *
 *   - **冪等性 (idempotency)**: cron が re-trigger されても結果は同じ。外部 cron (cron-job.org) は
 *     最低 1 回保証なので、複数回起動でも安全に動かなければならない。
 *     - 月初リセット: WHERE lastResetAt < currentMonthStart で絞るため、すでに当月分が
 *       適用済みのテナントは再 update しない (= 第 2 回目以降は 0 件)。
 *     - プラン変更適用: 適用後に scheduledPlanChangeAt と scheduledNextPlan を NULL に
 *       戻すため、再実行しても対象 0 件 (= 副作用なし)。
 *
 *   - **UTC ベース**: 月の境界はテナントごとの timezone に依存させず UTC で固定。
 *     ユーザ向け表示 (請求書等) は別途 localize する想定。これにより cron 実行時刻
 *     (UTC) と境界判定 (UTC) が一致し、タイムゾーン考慮ミスを避けられる。
 *
 *   - **scheduledNextPlan 検証**: DB に保存された値が壊れている場合 (将来の OS 変更等で)
 *     不正値が混入する可能性に備え、適用時点で `isTenantPlan` で検証。不正値はログ記録
 *     してスキップ (cron 全体は止めない)。
 *
 *   - **deletedAt フィルタ**: 削除済テナントは集計対象外。
 *
 *   - **トランザクションを使わない**: 月次リセットはテナントごとに独立した update であり、
 *     一括 transaction にすると 1 件失敗で全体 rollback になる。テナントごとに try/catch
 *     して結果を集計する方が運用上安全 (失敗 1 件で他全件のリセットを落とさない)。
 *
 * 関連:
 *   - cron endpoint: src/app/api/cron/tenant-monthly-reset/route.ts
 *   - スケジュール定義: cron-job.org dashboard (ADR-0023 で Vercel Cron から移行)
 *   - 設計: docs/design/SUGGESTION_ENGINE.md §課金モデル
 *   - 計画: docs/roadmap/SUGGESTION_ENGINE_PLAN.md PR #2 章
 */

import { prisma } from '@/lib/db';
import { recordError } from '@/services/error-log.service';
import { isTenantPlan, MANAGEMENT_TENANT_ID, DEFAULT_TENANT_ID } from '@/lib/tenant';
// ADR-0019 (2026-05-24): 月次 snapshot の集計は課金対象 featureUnit のみ対象。
import {
  BILLABLE_FEATURE_UNITS,
  EMBEDDING_BILLABLE_FEATURE_UNITS,
} from '@/config/billing-feature-units';
// chore/storage-addon-backend-removal (2026-05-26):
//   ADR-0020/0021 で従量課金化済のため旧 4 段階プラン (Standard/Plus/Pro/Enterprise) は撤去。
//   storageAddonPlan / storageAddonJpy の snapshot 保存と applyScheduledStorageChanges 関連 stub を削除。
import { purgeOldDeletedTenants } from '@/services/super-admin.service';
// ADR-0020 (2026-05-25): DB 容量従量課金 (月中 peak ベース)
import {
  calculateOverageJpy,
  calculateStripeMeterQuantity,
  classifyDbCapacityLevel,
} from '@/config/db-capacity-pricing';
// ADR-0021 (2026-05-26): ファイルストレージ従量課金 (月中 peak ベース)
import {
  calculateFileStorageOverageJpy,
  calculateFileStorageStripeQuantity,
  classifyFileStorageLevel,
} from '@/config/file-storage-pricing';
// PR-4 (2026-05-15): テナント TZ ベースの月初判定
// ADR-0020 (2026-05-25): 退会時請求の current-month 識別子用に getTenantCurrentYearMonth も import
import {
  getTenantMonthStart,
  getTenantPreviousYearMonth,
  getTenantCurrentYearMonth,
} from '@/lib/tenant-time';
import { DEFAULT_TIMEZONE } from '@/config/i18n';
// 2026-05-14: 縮退モード確定仕様 — 月初に embedding=NULL のエンティティを一括補完。
import { runMonthlyEmbeddingBackfill } from '@/services/embedding-backfill.service';
// 注: getTenantNextMonthStart は ADR-0020 改修後の現コードでは未使用 (旧 saveMonthlyUsageSnapshots
//   が prevMonthMid 経由で TZ 月初を導出するため不要)。export 維持は呼出側互換のみ。

/**
 * 2026-05-11: 月次使用量履歴のスナップショット保存対象から **除外** するテナント。
 *
 * Default テナント (運営者自身) は請求対象外のため、月次履歴 (= 請求書根拠) には残さない。
 * 過去 PR では MANAGEMENT_TENANT_ID のみ除外していたため Default の月次スナップショットが
 * 蓄積されてしまい、CSV エクスポート (過去月) や履歴グラフに混入する不具合があった。
 */
const SNAPSHOT_EXCLUDED_TENANT_IDS = [MANAGEMENT_TENANT_ID, DEFAULT_TENANT_ID];

export interface TenantMonthlyResetResult {
  /** 月初リセット対象として update したテナント件数。 */
  resetCount: number;
  /** プラン変更を適用したテナント件数。 */
  planAppliedCount: number;
  /** scheduledNextPlan が不正値のため skip した件数 (DB 不整合検知)。 */
  invalidPlanSkippedCount: number;
  /** P-5b (2026-05-08): スナップショット保存件数 (= 履歴テーブルに insert した件数)。 */
  snapshotSavedCount: number;
  /** テナント物理削除 (2026-05-08): 90 日経過解約済テナントの purge 件数 */
  purgedTenantCount: number;
  /** テナント物理削除: 削除した業務データレコード総数 (容量解放量の指標) */
  purgedRowCount: number;
  /** 縮退モード確定仕様 (2026-05-14): 月初 embedding 補完で対象になったテナント件数。 */
  embeddingBackfillTenantCount: number;
  /** 縮退モード確定仕様 (2026-05-14): 月初 embedding 補完で生成成功した embedding 総数。 */
  embeddingBackfillGeneratedCount: number;
  /** ADR-0020 (2026-05-25): DB 容量超過で ApiCallLog INSERT したテナント件数 */
  dbCapacityBilledTenantCount: number;
  /** ADR-0020: DB 容量超過の合計請求額 (円、当月 cron で billed した分) */
  dbCapacityBilledTotalJpy: number;
  /** ADR-0021 (2026-05-26): ファイルストレージ超過で ApiCallLog INSERT したテナント件数 */
  fileStorageBilledTenantCount: number;
  /** ADR-0021: ファイルストレージ超過の合計請求額 (円、当月 cron で billed した分) */
  fileStorageBilledTotalJpy: number;
}

/**
 * 当月の UTC 月初を返す (例: 2026-05-15T08:30:00Z → 2026-05-01T00:00:00Z)。
 *
 * **後方互換用**: PR-4 (2026-05-15) でテナント TZ 月初判定に切り替えたため、新規呼び出しは
 * `getTenantMonthStart(now, tenantTimezone)` (src/lib/tenant-time.ts) を使うこと。
 * 本関数は管理テナント / 非テナントスコープな処理に限り残置。
 */
export function getCurrentMonthStartUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * P-5b (2026-05-08, PR-4 で TZ 対応): 当月初の前月を "YYYY-MM" 文字列で返す。
 *
 * 月初リセット cron で snapshot を保存する yearMonth は **リセット対象月の 1 つ前** で
 * ある (= 「2026-05-01 のリセット時点では、4 月分の使用量を確定して 4 月分として保存する」)。
 *
 * @param now 計算基準時刻 (実運用時は cron 起動時刻 = 当月初付近)
 * @param timeZone 対象テナントの TZ (省略時 DEFAULT_TIMEZONE)
 * @returns "YYYY-MM" 形式 (例: Asia/Tokyo で 2026-05-15 を渡すと "2026-04")
 */
export function getPreviousYearMonth(
  now: Date = new Date(),
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  return getTenantPreviousYearMonth(now, timeZone);
}

/**
 * P-5b (2026-05-08): 月次リセット **直前** に各テナントの当月使用量をスナップショット保存する。
 *
 * 動作:
 *   - 対象: deletedAt IS NULL AND id != MANAGEMENT_TENANT_ID AND
 *           (lastResetAt IS NULL OR lastResetAt < 当月初) — リセット対象と同じ条件
 *   - 保存: tenant_monthly_usage_history に (tenantId, yearMonth=前月) で upsert
 *   - 冪等性: (tenantId, yearMonth) unique 制約で二重実行時も 1 行のみに収束
 *
 * 注意:
 *   この関数は resetTenantMonthlyCounters の **前** に呼ばなければならない
 *   (= リセット後だと値が 0 になっており snapshot に意味がない)。
 *
 * @returns insert / update に成功したテナント件数
 */
export async function saveMonthlyUsageSnapshots(now: Date = new Date()): Promise<number> {
  // PR-4 (2026-05-15): 各テナントの TZ ローカル月初を基準にする。
  //   従来は UTC 月初固定 (`getCurrentMonthStartUtc` / `getPreviousYearMonth`) だったが、
  //   テナント TZ に依存する月初境界を per-tenant で計算する設計に切替。
  //   全テナント (削除済除く / SNAPSHOT_EXCLUDED_TENANT_IDS 以外) を取得し、
  //   各テナントの月初判定を後段の filter で実施する。
  // 2026-05-11 (HEAD 履歴): Default テナント (= 運営者自身、請求対象外) も除外。
  //   過去 PR では MANAGEMENT のみ除外していたが、Default 分の月次履歴が請求 CSV に
  //   混入していたため SNAPSHOT_EXCLUDED_TENANT_IDS に追加済 (line 60 参照)。
  const allTenants = await prisma.tenant.findMany({
    where: {
      id: { notIn: SNAPSHOT_EXCLUDED_TENANT_IDS },
      deletedAt: null,
    },
    select: {
      id: true,
      plan: true,
      timezone: true,
      lastResetAt: true,
      currentMonthApiCallCount: true,
      currentMonthApiCostJpy: true,
      storageBytesUsed: true,
      // ADR-0021 (2026-05-26): ファイルストレージ peak を snapshot に永続化
      storageFileBytesPeakThisMonth: true,
    },
  });

  // 各テナントの TZ 月初を計算し、リセット対象か判定する
  const targets = allTenants.filter((t) => {
    const tenantMonthStart = getTenantMonthStart(now, t.timezone);
    return t.lastResetAt == null || t.lastResetAt < tenantMonthStart;
  });

  if (targets.length === 0) return 0;

  // アクティブユーザ数を groupBy で 1 クエリ取得 (N+1 回避)
  const userCounts = await prisma.user.groupBy({
    by: ['tenantId'],
    where: {
      isActive: true,
      deletedAt: null,
      tenantId: { in: targets.map((t) => t.id) },
    },
    _count: { id: true },
  });
  const userCountByTenant = new Map(userCounts.map((u) => [u.tenantId, u._count.id]));

  let saved = 0;
  for (const tenant of targets) {
    // PR-4: 各テナントの TZ で「前月の YYYY-MM」を計算
    const yearMonth = getTenantPreviousYearMonth(now, tenant.timezone);
    try {
      // ★ PR-V8.1 (2026-05-19) 請求 invariant: snapshot は ApiCallLog SUM (真値) ベースで保存。
      //   旧設計は counter (tenant.currentMonthApiCallCount/CostJpy) をそのまま snapshot に
      //   書いていたため、counter が drift している場合、過去月の snapshot に drift が
      //   永久固定され、過去月 CSV / 履歴表示で誤った金額が出る致命傷があった。
      //   ApiCallLog から「前月の範囲」を SUM することで、counter の状態に関わらず真値を保存する。
      //
      //   集計範囲: 前月のテナント TZ 月初 〜 当月のテナント TZ 月初
      //   例) Asia/Tokyo, 2026-05-19 実行時 → 2026-04-01 00:00 JST 〜 2026-05-01 00:00 JST
      const currentMonthStart = getTenantMonthStart(now, tenant.timezone);
      // 前月初を求めるため、月中の代表時刻として「前月15日 UTC」を使って per-tenant TZ 月初を計算
      // (15 日なら UTC とテナント TZ がどちらでも同じ月になるため安全)
      const prevMonthMid = new Date(currentMonthStart.getTime() - 16 * 24 * 60 * 60 * 1000);
      const prevMonthStart = getTenantMonthStart(prevMonthMid, tenant.timezone);
      // ADR-0019 (2026-05-24) → ADR-0022 (2026-06-01): 月次 snapshot は BILLABLE_FEATURE_UNITS の
      //   SUM (= LLM + Embedding + Storage Overage の合算) を保存する。
      //   無料 call (= EMBEDDING_BACKFILL / 未知 / Beginner Embedding cost=0) は costJpy=0 なので
      //   SUM 不変だが、_count._all は影響するため明示的に billable のみカウント。
      const apiAgg = await prisma.apiCallLog.aggregate({
        where: {
          tenantId: tenant.id,
          createdAt: { gte: prevMonthStart, lt: currentMonthStart },
          featureUnit: { in: [...BILLABLE_FEATURE_UNITS] },
        },
        _count: { _all: true },
        _sum: { costJpy: true },
      });
      // ADR-0019/0020/0022: reconciledCostJpy には LLM (project-upsert/suggestion-explanation/
      //   auto-tag-extract) + Embedding (knowledge/risk-issue/retrospective/memo/chat/import/
      //   attachment-embedding) + Storage Overage (db-capacity/file-storage) のすべてが入る。
      //   = 総請求額の根拠 (請求書 = 本値 = Stripe Meter 送信合計、feedback_billing_invariant)。
      const reconciledCallCount = apiAgg._count._all;
      const reconciledCostJpy = apiAgg._sum.costJpy ?? 0;

      // ADR-0021 (2026-05-26): file_storage_overage 部分を独立 SUM して history 列に保存。
      //   feedback_3layer_sync_filter: history で DB / file storage を分離表示するため。
      //   reconciledCostJpy (= 全 billable SUM) には既に含まれているので、本値は内訳表示専用。
      const fileStorageAgg = await prisma.apiCallLog.aggregate({
        where: {
          tenantId: tenant.id,
          createdAt: { gte: prevMonthStart, lt: currentMonthStart },
          featureUnit: 'storage-file-overage',
        },
        _sum: { costJpy: true },
      });
      const fileStorageOverageJpy = fileStorageAgg._sum.costJpy ?? 0;

      // ADR-0022 (2026-06-01): Embedding 系の内訳を独立 SUM して history 列に保存。
      //   feedback_3layer_sync_filter: history で LLM / Embedding / Storage を分離表示するため。
      //   reconciledCostJpy には既に含まれているので、本値は internal 列の breakdown 専用。
      //   Beginner プランは cost=0 だが件数 (_count._all) は記録 (= UI 表示用)。
      const embeddingAgg = await prisma.apiCallLog.aggregate({
        where: {
          tenantId: tenant.id,
          createdAt: { gte: prevMonthStart, lt: currentMonthStart },
          featureUnit: { in: [...EMBEDDING_BILLABLE_FEATURE_UNITS] },
        },
        _count: { _all: true },
        _sum: { costJpy: true },
      });
      const embeddingCallCount = embeddingAgg._count._all;
      const embeddingCostJpy = embeddingAgg._sum.costJpy ?? 0;

      // chore/storage-addon-backend-removal (2026-05-26): 旧 4 段階プラン月額は廃止のため
      //   totalJpy = API 利用料 (BILLABLE_FEATURE_UNITS で db-capacity / file-storage 超過も含む)。
      //   ADR-0022 で BILLABLE_FEATURE_UNITS が Embedding も含むため、Embedding 課金も自動的に
      //   totalJpy に乗る (= 二重カウントなし、SUM 真値)。
      const totalJpy = reconciledCostJpy;

      await prisma.tenantMonthlyUsageHistory.upsert({
        where: {
          tenantId_yearMonth: { tenantId: tenant.id, yearMonth },
        },
        create: {
          tenantId: tenant.id,
          yearMonth,
          apiCallCount: reconciledCallCount,
          apiCostJpy: reconciledCostJpy,
          plan: tenant.plan,
          activeUserCount: userCountByTenant.get(tenant.id) ?? 0,
          storageBytesUsed: tenant.storageBytesUsed,
          // ADR-0021 (2026-05-26): ファイルストレージ peak + 当月課金内訳
          fileStorageBytesPeak: tenant.storageFileBytesPeakThisMonth,
          fileStorageOverageJpy,
          // ADR-0022 (2026-06-01): Embedding 内訳
          embeddingCallCount,
          embeddingCostJpy,
          totalJpy,
        },
        update: {
          apiCallCount: reconciledCallCount,
          apiCostJpy: reconciledCostJpy,
          plan: tenant.plan,
          activeUserCount: userCountByTenant.get(tenant.id) ?? 0,
          storageBytesUsed: tenant.storageBytesUsed,
          fileStorageBytesPeak: tenant.storageFileBytesPeakThisMonth,
          fileStorageOverageJpy,
          // ADR-0022 (2026-06-01): Embedding 内訳
          embeddingCallCount,
          embeddingCostJpy,
          totalJpy,
        },
      });
      saved += 1;
    } catch (error) {
      await recordError({
        severity: 'error',
        source: 'cron',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        context: { kind: 'tenant_monthly_snapshot', tenantId: tenant.id, yearMonth },
      });
    }
  }

  return saved;
}

/**
 * 月初を跨いだテナントの API 呼び出しカウンタ + 課金額を 0 にリセットする (PR-4 でテナント TZ 月初基準に変更)。
 *
 * - 対象: deletedAt IS NULL AND (lastResetAt IS NULL OR lastResetAt < テナント TZ 当月初)
 * - 結果:
 *     - currentMonthApiCallCount=0, currentMonthApiCostJpy=0 (= LLM 系 counter)
 *     - currentMonthEmbeddingCallCount=0, currentMonthEmbeddingCostJpy=0 (= ADR-0022 で追加)
 *     - lastResetAt=テナント TZ 月初
 * - 冪等: 一度適用済みのテナントは再対象外
 *
 * **PR-V8 (2026-05-19) 改訂**: リセット前の counter 値を audit_log に記録するように変更。
 * **ADR-0022 (2026-06-01)**: Embedding counter (currentMonthEmbedding*) も同時にリセット。
 *   3 レイヤ同期 (feedback_3layer_sync_filter): Tenant counter / 月初 snapshot / 履歴 CSV を
 *   すべて更新する。Embedding counter は LLM とは独立に管理しているため、リセット漏れの
 *   影響範囲は「翌月の累積件数が永遠に膨らみ続ける」となり致命的。
 *
 * 注意: cron は UTC ベースの起動時刻で動くが、判定はテナントごとの TZ ローカル月初。
 * cron を最低 hourly で動かせば各テナントの TZ 月初を逃さない。
 */
export async function resetTenantMonthlyCounters(now: Date = new Date()): Promise<number> {
  // PR-4: per-tenant TZ 判定のため findMany + filter + 個別 update に変更
  const allTenants = await prisma.tenant.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      timezone: true,
      lastResetAt: true,
      // PR-V8: audit_log の before 値として記録
      currentMonthApiCallCount: true,
      currentMonthApiCostJpy: true,
      // ADR-0022 (2026-06-01): Embedding counter も before 値として audit_log 記録
      currentMonthEmbeddingCallCount: true,
      currentMonthEmbeddingCostJpy: true,
    },
  });

  // PR-V8: system user (= cron 実行主体) を audit_log の userId として記録。
  //   存在しなければ audit を作らず update のみ実行する。
  const systemUser = await prisma.user.findFirst({
    where: { systemRole: 'super_admin', isActive: true, deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  let resetCount = 0;
  for (const t of allTenants) {
    const monthStart = getTenantMonthStart(now, t.timezone);
    if (t.lastResetAt == null || t.lastResetAt < monthStart) {
      if (systemUser) {
        // counter リセット + audit_log を 1 transaction で
        await prisma.$transaction([
          prisma.tenant.update({
            where: { id: t.id },
            data: {
              currentMonthApiCallCount: 0,
              currentMonthApiCostJpy: 0,
              // ADR-0022 (2026-06-01): Embedding counter も同時リセット
              currentMonthEmbeddingCallCount: 0,
              currentMonthEmbeddingCostJpy: 0,
              lastResetAt: monthStart,
            },
          }),
          prisma.auditLog.create({
            data: {
              tenantId: t.id,
              userId: systemUser.id,
              action: 'UPDATE',
              entityType: 'tenant',
              entityId: t.id,
              beforeValue: {
                currentMonthApiCallCount: t.currentMonthApiCallCount,
                currentMonthApiCostJpy: t.currentMonthApiCostJpy,
                // ADR-0022: Embedding counter before
                currentMonthEmbeddingCallCount: t.currentMonthEmbeddingCallCount,
                currentMonthEmbeddingCostJpy: t.currentMonthEmbeddingCostJpy,
                lastResetAt: t.lastResetAt?.toISOString() ?? null,
              },
              afterValue: {
                operation: 'monthly-reset',
                currentMonthApiCallCount: 0,
                currentMonthApiCostJpy: 0,
                // ADR-0022: Embedding counter after
                currentMonthEmbeddingCallCount: 0,
                currentMonthEmbeddingCostJpy: 0,
                lastResetAt: monthStart.toISOString(),
                timezone: t.timezone,
              },
            },
          }),
        ]);
      } else {
        // 既存テナントだけで super_admin user 不在のケース (= 初回起動時の seed 直後等)
        await prisma.tenant.update({
          where: { id: t.id },
          data: {
            currentMonthApiCallCount: 0,
            currentMonthApiCostJpy: 0,
            // ADR-0022 (2026-06-01): Embedding counter も同時リセット
            currentMonthEmbeddingCallCount: 0,
            currentMonthEmbeddingCostJpy: 0,
            lastResetAt: monthStart,
          },
        });
      }
      resetCount += 1;
    }
  }
  return resetCount;
}

/**
 * scheduledPlanChangeAt 到達テナントに scheduledNextPlan を適用する。
 *
 * - 対象: deletedAt IS NULL AND scheduledPlanChangeAt <= now AND scheduledNextPlan IS NOT NULL
 * - 結果: plan=scheduledNextPlan, scheduledPlanChangeAt=NULL, scheduledNextPlan=NULL
 * - scheduledNextPlan が不正値ならエラーログ記録 + skip (該当テナントは scheduled 列を残す)
 */
export async function applyScheduledPlanChanges(
  now: Date = new Date(),
): Promise<{ applied: number; invalidSkipped: number }> {
  const candidates = await prisma.tenant.findMany({
    where: {
      deletedAt: null,
      scheduledPlanChangeAt: { lte: now },
      scheduledNextPlan: { not: null },
    },
    select: { id: true, scheduledNextPlan: true },
  });

  let applied = 0;
  let invalidSkipped = 0;

  for (const tenant of candidates) {
    const nextPlan = tenant.scheduledNextPlan;
    if (!isTenantPlan(nextPlan)) {
      // DB 不整合: 過去のリリースから値が壊れている / 手動 SQL で不正値が入った等
      invalidSkipped += 1;
      await recordError({
        severity: 'error',
        source: 'cron',
        message: `Invalid scheduledNextPlan: ${String(nextPlan)} (tenant=${tenant.id})`,
        context: { kind: 'tenant_plan_apply', tenantId: tenant.id, nextPlan },
      });
      continue;
    }

    try {
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          plan: nextPlan,
          scheduledPlanChangeAt: null,
          scheduledNextPlan: null,
        },
      });
      applied += 1;
    } catch (error) {
      // 1 テナントの失敗で cron 全体を落とさない (他テナントは適用継続)
      await recordError({
        severity: 'error',
        source: 'cron',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        context: { kind: 'tenant_plan_apply', tenantId: tenant.id },
      });
    }
  }

  return { applied, invalidSkipped };
}

/**
 * ADR-0020 (2026-05-25): DB 容量従量課金 — 月中 peak ベースで前月分を ApiCallLog に記録。
 *
 * 動作:
 *   - 対象: deletedAt IS NULL AND SNAPSHOT_EXCLUDED_TENANT_IDS 以外
 *   - storageBytesPeakThisMonth を読出 → calculateOverageJpy で課金額算出
 *   - 課金額 > 0 なら:
 *       1. ApiCallLog INSERT (featureUnit='db-capacity-overage', costJpy, createdAt=月跨ぎ瞬間)
 *       2. Tenant.currentMonthApiCostJpy increment (= billing invariant 維持)
 *       3. StripeUsageRecordQueue enqueue (callType='db_capacity_overage', quantity=costJpy 整数 R6 案 A)
 *   - 課金有無に関わらず:
 *       4. storageBytesPeakThisMonth = storageBytesUsed (= 新月の起点に reset)
 *       5. dbCapacityWarningLevel = classify(現在値) で再計算
 *       6. dbInstanceBytesPeakThisMonth = NULL (= drift 監視リセット)
 *
 * 順序重要: saveMonthlyUsageSnapshots より **前** に実行する。
 *   さもないと TenantMonthlyUsageHistory に db-capacity-overage 分が反映されない。
 *
 * トランザクション: 1 テナント = 1 transaction で確定 (= 真値経路の不整合を物理的に不可能化)。
 *
 * 関連: ADR-0020 §4.1 / docs/adr/0020-db-capacity-usage-based-billing.md
 */
export async function processTenantDbCapacityOverage(
  now: Date = new Date(),
): Promise<{ billedTenantCount: number; totalBilledJpy: number }> {
  const tenants = await prisma.tenant.findMany({
    where: {
      id: { notIn: SNAPSHOT_EXCLUDED_TENANT_IDS },
      deletedAt: null,
    },
    select: {
      id: true,
      timezone: true,
      lastResetAt: true,
      storageBytesUsed: true,
      storageBytesPeakThisMonth: true,
      // chore/storage-addon-backend-removal (2026-05-26): storageGracePeriodStartedAt は DB から撤去済
    },
  });

  // 当該月既に処理済 (= lastResetAt < 今 cron での月初なら未処理) のフィルタ
  const targets = tenants.filter((t) => {
    const monthStart = getTenantMonthStart(now, t.timezone);
    return t.lastResetAt == null || t.lastResetAt < monthStart;
  });

  // 4 回目検証 (G-2) で発見した N+1 修正: audit_log.userId に使う systemUser は
  // ループの **外** で 1 度だけ取得して引数で渡す (= 数百テナントで cron timeout 防止)
  const systemUserForAudit = await prisma.user.findFirst({
    where: { systemRole: 'super_admin', isActive: true, deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  let billedTenantCount = 0;
  let totalBilledJpy = 0;

  for (const tenant of targets) {
    try {
      const result = await billOneTenantDbCapacityOverage({
        tenantId: tenant.id,
        timezone: tenant.timezone,
        storageBytesUsed: tenant.storageBytesUsed,
        storageBytesPeakThisMonth: tenant.storageBytesPeakThisMonth,
        billingScope: 'previous-month', // cron は前月分を請求
        now,
        systemUserIdForAudit: systemUserForAudit?.id ?? null,
      });

      if (result.billedJpy > 0) {
        billedTenantCount += 1;
        totalBilledJpy += result.billedJpy;
      }
    } catch (error) {
      // 1 テナントの失敗で他テナントの処理を止めない
      await recordError({
        severity: 'error',
        source: 'cron',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        context: {
          kind: 'tenant_db_capacity_overage',
          tenantId: tenant.id,
          peakBytes: tenant.storageBytesPeakThisMonth.toString(),
        },
      });
    }
  }

  return { billedTenantCount, totalBilledJpy };
}

/**
 * 単一テナントの DB 容量超過分を ApiCallLog INSERT する共通ロジック (ADR-0020 / 2026-05-25)。
 *
 * 用途:
 *   - 月初 cron (processTenantDbCapacityOverage): 全テナント前月分一括 → billingScope='previous-month'
 *   - 退会時 (tenant-withdrawal-billing.service): 単一テナント当月分即時 → billingScope='current-month-on-withdrawal'
 *
 * 動作:
 *   1. peak から calculateOverageJpy で costJpy 算出
 *   2. > 0 なら ApiCallLog INSERT + counter increment + Stripe queue enqueue (= billing invariant)
 *   3. peak / drift / warning level を reset (退会時は呼出側の論理削除でカラム解放される)
 *
 * R5 横断対応 (DB 容量 + API 利用量を退会時に抜け漏れなく請求):
 *   - API 利用量は既存の saveMonthlyUsageSnapshots / deleteTenant 内 SUM で吸収される
 *   - DB 容量は本関数を呼ぶことで月末 cron を待たずに請求可能
 *
 * @returns { billedJpy, apiCallLogId } 課金実施時は billedJpy > 0、なければ 0 + apiCallLogId=null
 */
export async function billOneTenantDbCapacityOverage(args: {
  tenantId: string;
  timezone: string;
  storageBytesUsed: bigint;
  storageBytesPeakThisMonth: bigint;
  /** 'previous-month' = 月初 cron 用 (createdAt は前月末瞬間)、'current-month-on-withdrawal' = 退会用 (createdAt は now) */
  billingScope: 'previous-month' | 'current-month-on-withdrawal';
  now: Date;
  /**
   * 4 回目検証 G-2 で追加: audit_log.userId 用。
   * 呼出ループの外で 1 度だけ取得した systemUser を渡す。
   * 未指定 (= 後方互換) なら関数内で fallback として findFirst 実行 (1 件) するが、
   * 大量呼出時は外部から渡すこと。
   */
  systemUserIdForAudit?: string | null;
}): Promise<{ billedJpy: number; apiCallLogId: string | null }> {
  const { tenantId, timezone, storageBytesUsed, storageBytesPeakThisMonth, billingScope, now } = args;

  const peakBytes = storageBytesPeakThisMonth;
  const costJpy = calculateOverageJpy(peakBytes);
  const stripeQuantity = calculateStripeMeterQuantity(costJpy);

  // 月跨ぎ識別子 (= ApiCallLog.requestId / 二重 INSERT 防止用)
  // - previous-month: 前月の yearMonth (月初 cron 用)
  // - current-month-on-withdrawal: 当月の yearMonth (退会用)
  //
  // R5-横断対応 (3 回目検証で発見した B-1): 二重請求防止のため
  //   requestId に billingScope も合成し、scope ごとに完全 unique。
  //   ・月初 cron (previous-month) と退会 (current-month-on-withdrawal) が同月実行されても
  //     scope サフィックスで識別され二重 INSERT 不可
  //   ・将来 scope が増えた場合も「{base}-{tenant}-{ym}-{scope}」で衝突なし
  //   ・Stripe identifier も同じ requestId 基準で 24h 重複防止
  const monthStart = getTenantMonthStart(now, timezone);
  const prevMonthEndInstant = new Date(monthStart.getTime() - 1);
  const createdAtForBilling =
    billingScope === 'previous-month' ? prevMonthEndInstant : now;
  const occurredAtForStripe = createdAtForBilling;
  const yearMonthForRequest =
    billingScope === 'previous-month'
      ? getTenantPreviousYearMonth(now, timezone)
      : getTenantCurrentYearMonth(now, timezone);
  // billingScope を必ず requestId に含めて scope 越え二重課金を物理的に不可能化
  const requestId = `db-capacity-overage-${tenantId}-${yearMonthForRequest}-${billingScope}`;

  let createdLogId: string | null = null;

  // 単一 transaction で billing invariant を確定 (ApiCallLog + counter + Stripe queue + audit_log)
  await prisma.$transaction(async (tx) => {
    if (costJpy > 0) {
      // 1. ApiCallLog INSERT (真値、ADR-0020)
      const log = await tx.apiCallLog.create({
        data: {
          tenantId,
          userId: null,
          featureUnit: 'db-capacity-overage',
          modelName: 'db-capacity',
          llmInputTokens: null,
          llmOutputTokens: null,
          embeddingTokens: null,
          costJpy,
          latencyMs: 0,
          requestId,
          createdAt: createdAtForBilling,
        },
      });
      createdLogId = log.id;

      // 2. Tenant.currentMonthApiCostJpy increment
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          currentMonthApiCostJpy: { increment: costJpy },
        },
      });

      // 3. StripeUsageRecordQueue enqueue (R6 案 A: quantity=costJpy 整数)
      await tx.stripeUsageRecordQueue.create({
        data: {
          tenantId,
          callType: 'db_capacity_overage',
          apiCallLogId: log.id,
          quantity: stripeQuantity,
          occurredAt: occurredAtForStripe,
          nextSendAt: now,
        },
      });

      // 4. audit_log INSERT (E-1: 3 回目検証で発見した運用性ギャップ修正)
      //    誤請求や問い合わせ発生時に「いつ・どの peak で・いくら billed したか」を追跡可能にする
      //    userId は cron / 退会 API どちらも system 起動。
      //    4 回目検証 G-2: 呼出側から渡される systemUserIdForAudit を優先、未指定なら fallback で 1 回検索
      let systemUserId: string | null = args.systemUserIdForAudit ?? null;
      if (systemUserId === null) {
        const systemUserForAudit = await tx.user.findFirst({
          where: { systemRole: 'super_admin', isActive: true, deletedAt: null },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        });
        systemUserId = systemUserForAudit?.id ?? null;
      }
      if (systemUserId) {
        await tx.auditLog.create({
          data: {
            tenantId,
            userId: systemUserId,
            action: 'CREATE',
            entityType: 'api_call_log',
            entityId: log.id,
            beforeValue: { storageBytesPeakThisMonth: peakBytes.toString() },
            afterValue: {
              featureUnit: 'db-capacity-overage',
              billingScope,
              costJpy,
              stripeQuantity,
              requestId,
              billedAt: createdAtForBilling.toISOString(),
              adr: 'ADR-0020',
            },
          },
        });
      }
    }

    // 4-6. peak / level / drift を reset
    //   - previous-month: 新月の起点 = 現在 storageBytesUsed
    //   - current-month-on-withdrawal: テナント論理削除されるが念のため reset (Stripe queue 残置のため対象として残る)
    const currentUsedBytes = storageBytesUsed;
    const newLevel = classifyDbCapacityLevel(currentUsedBytes);
    await tx.tenant.update({
      where: { id: tenantId },
      data: {
        storageBytesPeakThisMonth: currentUsedBytes,
        storageBytesPeakAt: now,
        dbInstanceBytesPeakThisMonth: null,
        dbCapacityWarningLevel: newLevel,
      },
    });
  });

  return { billedJpy: costJpy, apiCallLogId: createdLogId };
}

// ============================================================
// ADR-0021 (2026-05-26): ファイルストレージ従量課金
// ============================================================

/**
 * ファイルストレージ peak から月次請求を ApiCallLog に記録 (ADR-0021 §4)。
 *
 * 順序: processTenantDbCapacityOverage と同じく saveMonthlyUsageSnapshots **前** に呼ぶ。
 * trans: 1 テナント = 1 transaction (= 真値経路の不整合を物理的に不可能化)。
 *
 * 関連: ADR-0021 §4 / src/config/file-storage-pricing.ts
 */
export async function processTenantFileStorageOverage(
  now: Date = new Date(),
): Promise<{ billedTenantCount: number; totalBilledJpy: number }> {
  const tenants = await prisma.tenant.findMany({
    where: {
      id: { notIn: SNAPSHOT_EXCLUDED_TENANT_IDS },
      deletedAt: null,
    },
    select: {
      id: true,
      timezone: true,
      lastResetAt: true,
      storageFileBytesUsed: true,
      storageFileBytesPeakThisMonth: true,
    },
  });

  const targets = tenants.filter((t) => {
    const monthStart = getTenantMonthStart(now, t.timezone);
    return t.lastResetAt == null || t.lastResetAt < monthStart;
  });

  const systemUserForAudit = await prisma.user.findFirst({
    where: { systemRole: 'super_admin', isActive: true, deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  let billedTenantCount = 0;
  let totalBilledJpy = 0;

  for (const tenant of targets) {
    try {
      const result = await billOneTenantFileStorageOverage({
        tenantId: tenant.id,
        timezone: tenant.timezone,
        storageFileBytesUsed: tenant.storageFileBytesUsed,
        storageFileBytesPeakThisMonth: tenant.storageFileBytesPeakThisMonth,
        billingScope: 'previous-month',
        now,
        systemUserIdForAudit: systemUserForAudit?.id ?? null,
      });

      if (result.billedJpy > 0) {
        billedTenantCount += 1;
        totalBilledJpy += result.billedJpy;
      }
    } catch (error) {
      await recordError({
        severity: 'error',
        source: 'cron',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        context: {
          kind: 'tenant_file_storage_overage',
          tenantId: tenant.id,
          peakBytes: tenant.storageFileBytesPeakThisMonth.toString(),
        },
      });
    }
  }

  return { billedTenantCount, totalBilledJpy };
}

/**
 * 単一テナントの月次ファイルストレージ請求を ApiCallLog に記録する。
 * 月初 cron (previous-month) と退会時 (current-month-on-withdrawal) で共通利用。
 */
export async function billOneTenantFileStorageOverage(args: {
  tenantId: string;
  timezone: string;
  storageFileBytesUsed: bigint;
  storageFileBytesPeakThisMonth: bigint;
  billingScope: 'previous-month' | 'current-month-on-withdrawal';
  now: Date;
  systemUserIdForAudit?: string | null;
}): Promise<{ billedJpy: number; apiCallLogId: string | null }> {
  const { tenantId, timezone, storageFileBytesUsed, storageFileBytesPeakThisMonth, billingScope, now } = args;

  const peakBytes = storageFileBytesPeakThisMonth;
  const costJpy = calculateFileStorageOverageJpy(peakBytes);
  const stripeQuantity = calculateFileStorageStripeQuantity(costJpy);

  const monthStart = getTenantMonthStart(now, timezone);
  const prevMonthEndInstant = new Date(monthStart.getTime() - 1);
  const createdAtForBilling =
    billingScope === 'previous-month' ? prevMonthEndInstant : now;
  const occurredAtForStripe = createdAtForBilling;
  const yearMonthForRequest =
    billingScope === 'previous-month'
      ? getTenantPreviousYearMonth(now, timezone)
      : getTenantCurrentYearMonth(now, timezone);
  const requestId = `storage-file-overage-${tenantId}-${yearMonthForRequest}-${billingScope}`;

  let createdLogId: string | null = null;

  await prisma.$transaction(async (tx) => {
    if (costJpy > 0) {
      const log = await tx.apiCallLog.create({
        data: {
          tenantId,
          userId: null,
          featureUnit: 'storage-file-overage',
          modelName: 'storage-file',
          llmInputTokens: null,
          llmOutputTokens: null,
          embeddingTokens: null,
          costJpy,
          latencyMs: 0,
          requestId,
          createdAt: createdAtForBilling,
        },
      });
      createdLogId = log.id;

      await tx.tenant.update({
        where: { id: tenantId },
        data: { currentMonthApiCostJpy: { increment: costJpy } },
      });

      await tx.stripeUsageRecordQueue.create({
        data: {
          tenantId,
          callType: 'storage_file_overage',
          apiCallLogId: log.id,
          quantity: stripeQuantity,
          occurredAt: occurredAtForStripe,
          nextSendAt: now,
        },
      });

      let systemUserId: string | null = args.systemUserIdForAudit ?? null;
      if (systemUserId === null) {
        const systemUserForAudit = await tx.user.findFirst({
          where: { systemRole: 'super_admin', isActive: true, deletedAt: null },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        });
        systemUserId = systemUserForAudit?.id ?? null;
      }
      if (systemUserId) {
        await tx.auditLog.create({
          data: {
            tenantId,
            userId: systemUserId,
            action: 'CREATE',
            entityType: 'api_call_log',
            entityId: log.id,
            beforeValue: { storageFileBytesPeakThisMonth: peakBytes.toString() },
            afterValue: {
              featureUnit: 'storage-file-overage',
              billingScope,
              costJpy,
              stripeQuantity,
              requestId,
              billedAt: createdAtForBilling.toISOString(),
              adr: 'ADR-0021',
            },
          },
        });
      }
    }

    // peak / level / drift を reset
    const currentUsedBytes = storageFileBytesUsed;
    const newLevel = classifyFileStorageLevel(currentUsedBytes);
    await tx.tenant.update({
      where: { id: tenantId },
      data: {
        storageFileBytesPeakThisMonth: currentUsedBytes,
        storageFileBytesPeakAt: now,
        storageBucketBytesPeakThisMonth: null,
        fileStorageWarningLevel: newLevel,
      },
    });
  });

  return { billedJpy: costJpy, apiCallLogId: createdLogId };
}

/**
 * 月次バッチのエントリポイント。外部 cron (cron-job.org) が叩く API ルートから呼ばれる。
 *
 * 順序 (ADR-0020 / 2026-05-25 改訂):
 *   1. **processTenantDbCapacityOverage**: DB 容量超過分を ApiCallLog INSERT (前月分として)
 *   2. saveMonthlyUsageSnapshots: 前月分の使用量を tenant_monthly_usage_history に保存
 *      (= 上記 ApiCallLog を含めた真値で snapshot)
 *   3. resetTenantMonthlyCounters: API call counter / cost をリセット
 *   4. applyScheduledPlanChanges: プラン変更予約を適用
 *   5. applyScheduledStorageChanges (P9-cleanup 予定): 旧 storage addon 予約
 *   6. runMonthlyEmbeddingBackfill: 縮退モード補完
 *   7. purgeOldDeletedTenants: 90 日経過テナント物理削除
 */
export async function runTenantMonthlyReset(
  now: Date = new Date(),
): Promise<TenantMonthlyResetResult> {
  // ADR-0020 (2026-05-25): まず DB 容量超過分を ApiCallLog として記録する。
  //   これにより後続の saveMonthlyUsageSnapshots が「db-capacity-overage を含んだ正しい SUM」を保存する。
  const dbCapacityResult = await processTenantDbCapacityOverage(now);
  // ADR-0021 (2026-05-26): ファイルストレージ超過も同様に ApiCallLog 化 (順序重要: snapshot 前)
  const fileStorageResult = await processTenantFileStorageOverage(now);

  // P-5b: リセット直前にスナップショット保存 (順序重要: reset 後だと値が 0 になる)
  const snapshotSavedCount = await saveMonthlyUsageSnapshots(now);
  const resetCount = await resetTenantMonthlyCounters(now);
  const { applied, invalidSkipped } = await applyScheduledPlanChanges(now);
  // chore/storage-addon-backend-removal (2026-05-26):
  //   ADR-0020/0021 で完全従量課金化されたため、旧 4 段階プラン (Standard/Plus/Pro/Enterprise) の
  //   ダウングレード予約適用フローは撤去。storageAddonAppliedCount / storageAddonSkippedCount も result から削除。
  // 縮退モード確定仕様 (2026-05-14): counter リセット **後** に embedding=NULL の業務エンティティを
  //   一括補完する (= 当月の予算枠を使うので、当月分の課金として記録される)。
  //   テナント月間上限を超える分は次月の cron に持ち越され、過剰課金しない設計。
  //   失敗してもテナント物理削除は実施するため、try/catch で囲んで結果のみ集計する。
  let embeddingBackfillTenantCount = 0;
  let embeddingBackfillGeneratedCount = 0;
  try {
    const backfill = await runMonthlyEmbeddingBackfill();
    embeddingBackfillTenantCount = backfill.tenantCount;
    embeddingBackfillGeneratedCount = backfill.results.reduce(
      (sum, r) =>
        sum +
        (r.generated.projects ?? 0) +
        (r.generated.knowledges ?? 0) +
        (r.generated.risks_issues ?? 0) +
        (r.generated.retrospectives ?? 0),
      0,
    );
  } catch (error) {
    await recordError({
      severity: 'error',
      source: 'cron',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      context: { kind: 'monthly_embedding_backfill' },
    });
  }
  // テナント物理削除 (2026-05-08): 論理削除から 90 日経過したテナントの業務データを物理削除
  //   (= 容量解放、課金根拠 + 監査ログは保護)
  const purgeResult = await purgeOldDeletedTenants(now);
  return {
    resetCount,
    planAppliedCount: applied,
    invalidPlanSkippedCount: invalidSkipped,
    snapshotSavedCount,
    purgedTenantCount: purgeResult.succeeded,
    purgedRowCount: purgeResult.totalRowsDeleted,
    embeddingBackfillTenantCount,
    embeddingBackfillGeneratedCount,
    dbCapacityBilledTenantCount: dbCapacityResult.billedTenantCount,
    dbCapacityBilledTotalJpy: dbCapacityResult.totalBilledJpy,
    fileStorageBilledTenantCount: fileStorageResult.billedTenantCount,
    fileStorageBilledTotalJpy: fileStorageResult.totalBilledJpy,
  };
}

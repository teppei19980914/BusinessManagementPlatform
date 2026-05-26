/**
 * GET /api/admin/super/usage/export?yearMonth=YYYY-MM&includeDeleted=true (P-5b / 2026-05-08)
 *
 * 役割:
 *   super_admin が月次の請求業務を行うための CSV ダウンロード。
 *
 *   - yearMonth 指定なし: **当月** の現在値 (リセット前の暫定値) を CSV 化
 *     → `Tenant.currentMonthApiCallCount/CostJpy` を集計
 *   - yearMonth 指定あり (過去月): 履歴テーブルから取得
 *     → `tenant_monthly_usage_history` から取得
 *
 * クエリパラメタ:
 *   - yearMonth: 'YYYY-MM' (省略時は当月)
 *   - includeDeleted: 'true' を指定すると解約済テナントも CSV に含める
 *     (2026-05-14 追加。月途中解約の請求漏れ検知用)
 *
 * 認可:
 *   super_admin role 必須。それ以外は 403。
 *
 * 出力:
 *   - Content-Type: text/csv; charset=utf-8
 *   - UTF-8 BOM 付き (Excel で日本語を文字化けさせないため)
 *   - 列: テナント連番 / テナント名 / プラン / API 呼出回数 / API 課金額 (円) /
 *         アクティブユーザ数 / 月次予算上限 (空欄=無制限) / 解約日 (空欄=アクティブ)
 *   - ファイル名: tenant-usage-{yearMonth}.csv
 *
 * 関連:
 *   - 履歴サービス: src/services/super-admin.service.ts (listMonthlyUsageHistory)
 *   - 当月サービス: src/services/super-admin.service.ts (listAllTenants)
 *   - UI: src/app/(dashboard)/admin/super/usage/page.tsx
 *   - 月次請求運用: docs/operations/BILLING_MONTHLY_OPERATIONS.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import {
  listAllTenants,
  listMonthlyUsageHistory,
} from '@/services/super-admin.service';
// PR-V8 (2026-05-19) ★請求重要★: 当月 CSV は counter 値ではなく ApiCallLog SUM を
//   真値として書き出す (= drift があっても請求書根拠は真値で出力)。drift があれば
//   警告列で明示する。
import { reconcileAllTenantsApiUsage } from '@/services/api-usage-recalc.service';
// ADR-0021 (2026-05-26): ファイルストレージ peak から想定請求額算出
import { calculateFileStorageOverageJpy } from '@/config/file-storage-pricing';

/** "YYYY-MM" 形式 (1-12 月の 0 埋め必須)。 */
const YearMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, '形式は YYYY-MM (例: 2026-04)');

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  if (!isSuperAdmin(user)) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN' } },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const rawYearMonth = url.searchParams.get('yearMonth');
  // 2026-05-14: 解約済テナント込みで取得するか (月途中解約の請求漏れ検知用)
  const includeDeleted = url.searchParams.get('includeDeleted') === 'true';

  let csv: string;
  let filename: string;

  if (rawYearMonth == null || rawYearMonth === '') {
    // 当月分: 現在の Tenant 値を集計
    const tenants = await listAllTenants({ includeDeleted });
    // PR-V8 ★請求重要★: ApiCallLog SUM (真値) を別途取得し、CSV では SUM を主軸にする
    const reconciles = await reconcileAllTenantsApiUsage();
    const reconcileByTenant = new Map(reconciles.map((r) => [r.tenantId, r]));
    const currentYearMonth = formatCurrentYearMonth();
    csv = buildCurrentMonthCsv(tenants, reconcileByTenant);
    filename = includeDeleted
      ? `tenant-usage-${currentYearMonth}-current-with-deleted.csv`
      : `tenant-usage-${currentYearMonth}-current.csv`;
  } else {
    // 過去月: 履歴テーブル (履歴クエリは deletedAt フィルタが元々ないため
    //   includeDeleted フラグの有無で結果は変わらないが、UI 経由の挙動を一貫させるため
    //   ファイル名のみに反映する)
    const parsed = YearMonthSchema.safeParse(rawYearMonth);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message } },
        { status: 400 },
      );
    }
    // 大きめの window から目的の yearMonth を抽出
    const all = await listMonthlyUsageHistory(24);
    const filtered = all.filter((r) => r.yearMonth === parsed.data);
    csv = buildHistoryCsv(filtered);
    filename = includeDeleted
      ? `tenant-usage-${parsed.data}-with-deleted.csv`
      : `tenant-usage-${parsed.data}.csv`;
  }

  // UTF-8 BOM 付与 (Excel での日本語文字化け回避)
  const body = '﻿' + csv;

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

// ================================================================
// CSV builders
// ================================================================

// P-G (2026-05-08): 当月データには請求先列を含める (super_admin の請求業務で
//   宛先情報がそのまま使えるように)。履歴 CSV は当月時点ではなくスナップショット時点の
//   集計値であり、請求先は最新を Tenant テーブルから別途参照すれば十分なため、
//   履歴 CSV には請求先列を含めない (= 列分離で運用混乱を避ける)。

const HEADERS_CURRENT = [
  'テナント連番',
  'テナント名',
  'プラン',
  // PR-V8 ★請求重要★: API 呼出回数 / 課金額は **ApiCallLog SUM を主軸** にする (drift があっても真値で出力)。
  //   counter 値も並記し、drift があれば警告列で明示する。
  'API呼出回数(ApiCallLog SUM=真値)',
  'API課金額(ApiCallLog SUM=真値, 円)',
  'API呼出回数(counter=参考)',
  'API課金額(counter=参考, 円)',
  'drift警告',
  'drift呼出差分',
  'drift費用差分(円)',
  'アクティブユーザ数',
  '月次予算上限(円)',
  // Storage add-on (Phase 2 / 2026-05-08): 容量と追加課金 + 合計
  'Storageプラン',
  'Storage使用量(バイト)',
  'Storage月額(円)',
  // ADR-0021 (2026-05-26): ファイルストレージ peak + 想定請求額 (= 当月 cron 確定前の予測値)
  'ファイルストレージ peak (バイト)',
  'ファイルストレージ超過 (円・想定)',
  '合計月額(円)',
  // 2026-05-14: 月途中解約の請求対象期間判別用 (空欄=アクティブ、ISO 日時=解約済)
  '解約日',
  // P-G: 請求先情報 / PR C (2026-05-09 #5/#8/#10) で構造化
  '請求先種別',
  '会社名_法人名',
  '請求担当者',
  '請求先メール',
  '電話番号',
  '支払い方法',
  '郵便番号',
  '都道府県',
  '市区町村',
  '番地町名',
  '建物名_部屋番号',
  '請求書送付先住所_legacy',
];

const HEADERS_HISTORY = [
  'テナント連番',
  'テナント名',
  'プラン',
  'API呼出回数',
  'API課金額(円)',
  'アクティブユーザ数',
  // Storage add-on (Phase 2 / 2026-05-08): スナップショット時点の Storage 情報
  'Storageプラン',
  'Storage使用量(バイト)',
  'Storage月額(円)',
  // ADR-0021 (2026-05-26): スナップショット時点のファイルストレージ peak + 当月課金
  'ファイルストレージ peak (バイト)',
  'ファイルストレージ超過 (円)',
  '合計月額(円)',
  // 2026-05-14: 月途中解約の請求対象期間判別用 (空欄=アクティブ、ISO 日時=解約済)
  '解約日',
];

function buildCurrentMonthCsv(
  tenants: Awaited<ReturnType<typeof listAllTenants>>,
  reconcileByTenant: Map<
    string,
    Awaited<ReturnType<typeof reconcileAllTenantsApiUsage>>[number]
  >,
): string {
  const lines = [HEADERS_CURRENT.join(',')];
  for (const t of tenants) {
    // PR-V8 ★請求重要★: SUM 値を真値として書き出す。reconcile が null (= 削除済等で取れない) の場合は
    //   counter 値にフォールバック (= 過去動作と同じ)。
    const reconcile = reconcileByTenant.get(t.id);
    const sumCallCount = reconcile?.reconciledCallCount ?? t.currentMonthApiCallCount;
    const sumCostJpy = reconcile?.reconciledCostJpy ?? t.currentMonthApiCostJpy;
    const driftWarning = reconcile?.hasDrift
      ? `⚠ drift ${(reconcile.driftRatio * 100).toFixed(1)}%`
      : '';
    const driftCallDiff = reconcile?.driftCallCount ?? 0;
    const driftCostDiff = reconcile?.driftCostJpy ?? 0;
    lines.push(
      [
        t.tenantSeq?.toString() ?? '',
        csvEscape(t.name),
        csvEscape(t.plan),
        // PR-V8: SUM 主軸 + counter 並記
        sumCallCount.toString(),
        sumCostJpy.toString(),
        t.currentMonthApiCallCount.toString(),
        t.currentMonthApiCostJpy.toString(),
        csvEscape(driftWarning),
        (driftCallDiff >= 0 ? '+' : '') + driftCallDiff.toString(),
        (driftCostDiff >= 0 ? '+' : '') + driftCostDiff.toString(),
        t.activeUserCount.toString(),
        t.monthlyBudgetCapJpy?.toString() ?? '',
        // Storage add-on
        csvEscape(t.storageAddonPlan),
        t.storageBytesUsed.toString(),
        t.storageAddonMonthlyJpy.toString(),
        // ADR-0021 (2026-05-26): ファイルストレージ peak + 想定請求額 (cron 確定前の予測)
        t.storageFileBytesPeakThisMonth.toString(),
        calculateFileStorageOverageJpy(BigInt(t.storageFileBytesPeakThisMonth)).toString(),
        // 合計月額: SUM ベースで再計算 (= drift 分を反映)
        (sumCostJpy + t.storageAddonMonthlyJpy).toString(),
        // 2026-05-14: 解約日 (空欄=アクティブ)
        t.deletedAt != null ? t.deletedAt.toISOString() : '',
        // P-G: 請求先列 / PR C (2026-05-09): 個人法人 + 構造化住所
        csvEscape(t.billingType === 'individual' ? '個人' : '法人'),
        csvEscape(t.billingCompanyName ?? ''),
        csvEscape(t.billingContactName ?? ''),
        csvEscape(t.billingContactEmail ?? ''),
        csvEscape(t.billingPhoneNumber ?? ''),
        csvEscape(t.paymentMethod),
        csvEscape(t.billingPostalCode ?? ''),
        csvEscape(t.billingPrefecture ?? ''),
        csvEscape(t.billingCity ?? ''),
        csvEscape(t.billingStreetAddress ?? ''),
        csvEscape(t.billingBuildingName ?? ''),
        csvEscape(t.billingAddress ?? ''),
      ].join(','),
    );
  }
  return lines.join('\r\n');
}

function buildHistoryCsv(rows: Awaited<ReturnType<typeof listMonthlyUsageHistory>>): string {
  const lines = [HEADERS_HISTORY.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.tenantSeq?.toString() ?? '',
        csvEscape(r.tenantName),
        csvEscape(r.plan),
        r.apiCallCount.toString(),
        r.apiCostJpy.toString(),
        r.activeUserCount.toString(),
        // Storage add-on (Phase 2): snapshot 時点の Storage 関連
        csvEscape(r.storageAddonPlan),
        r.storageBytesUsed.toString(),
        r.storageAddonJpy.toString(),
        // ADR-0021 (2026-05-26): スナップショット時点のファイルストレージ peak + 当月課金
        (r.fileStorageBytesPeak ?? 0).toString(),
        (r.fileStorageOverageJpy ?? 0).toString(),
        r.totalJpy.toString(),
        // 2026-05-14: 親テナントの解約日 (空欄=アクティブ)
        r.tenantDeletedAt != null ? r.tenantDeletedAt.toISOString() : '',
      ].join(','),
    );
  }
  return lines.join('\r\n');
}

/**
 * CSV のエスケープ。カンマ・改行・ダブルクォートを含む値はダブルクォートで囲み、
 * 内部のダブルクォートは 2 連続にする (RFC 4180)。
 *
 * 2026-05-13 (security/csv-formula-injection, B-4): Excel/Google Sheets の
 *   formula injection (CWE-1236) 対策。`=`/`+`/`-`/`@`/`\t`/`\r` で始まる値は
 *   `'` (シングルクォート) を前置し、Excel に文字列として解釈させる。
 *   data-export.service.ts の csvEscape と同じパターンで横展開。
 */
export function csvEscape(value: string): string {
  if (value === '') return '';
  // B-4: Formula Injection 対策
  if (/^[=+\-@\t\r]/.test(value)) value = "'" + value;
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatCurrentYearMonth(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

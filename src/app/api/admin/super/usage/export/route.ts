/**
 * GET /api/admin/super/usage/export?yearMonth=YYYY-MM (P-5b / 2026-05-08)
 *
 * 役割:
 *   super_admin が月次の請求業務を行うための CSV ダウンロード。
 *
 *   - yearMonth 指定なし: **当月** の現在値 (リセット前の暫定値) を CSV 化
 *     → `Tenant.currentMonthApiCallCount/CostJpy` を集計
 *   - yearMonth 指定あり (過去月): 履歴テーブルから取得
 *     → `tenant_monthly_usage_history` から取得
 *
 * 認可:
 *   super_admin role 必須。それ以外は 403。
 *
 * 出力:
 *   - Content-Type: text/csv; charset=utf-8
 *   - UTF-8 BOM 付き (Excel で日本語を文字化けさせないため)
 *   - 列: テナント連番 / テナント名 / プラン / API 呼出回数 / API 課金額 (円) /
 *         アクティブユーザ数 / 月次予算上限 (空欄=無制限)
 *   - ファイル名: tenant-usage-{yearMonth}.csv
 *
 * 関連:
 *   - 履歴サービス: src/services/super-admin.service.ts (listMonthlyUsageHistory)
 *   - 当月サービス: src/services/super-admin.service.ts (listAllTenants)
 *   - UI: src/app/(dashboard)/admin/super/usage/page.tsx
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import {
  listAllTenants,
  listMonthlyUsageHistory,
} from '@/services/super-admin.service';

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

  let csv: string;
  let filename: string;

  if (rawYearMonth == null || rawYearMonth === '') {
    // 当月分: 現在の Tenant 値を集計
    const tenants = await listAllTenants();
    const currentYearMonth = formatCurrentYearMonth();
    csv = buildCurrentMonthCsv(tenants);
    filename = `tenant-usage-${currentYearMonth}-current.csv`;
  } else {
    // 過去月: 履歴テーブル
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
    filename = `tenant-usage-${parsed.data}.csv`;
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
  'API呼出回数',
  'API課金額(円)',
  'アクティブユーザ数',
  '月次予算上限(円)',
  // P-G: 請求先情報
  '会社名_法人名',
  '請求担当者',
  '請求先メール',
  '電話番号',
  '支払い方法',
  '請求書送付先住所',
];

const HEADERS_HISTORY = [
  'テナント連番',
  'テナント名',
  'プラン',
  'API呼出回数',
  'API課金額(円)',
  'アクティブユーザ数',
];

function buildCurrentMonthCsv(tenants: Awaited<ReturnType<typeof listAllTenants>>): string {
  const lines = [HEADERS_CURRENT.join(',')];
  for (const t of tenants) {
    lines.push(
      [
        t.tenantSeq?.toString() ?? '',
        csvEscape(t.name),
        csvEscape(t.plan),
        t.currentMonthApiCallCount.toString(),
        t.currentMonthApiCostJpy.toString(),
        t.activeUserCount.toString(),
        t.monthlyBudgetCapJpy?.toString() ?? '',
        // P-G: 請求先列
        csvEscape(t.billingCompanyName ?? ''),
        csvEscape(t.billingContactName ?? ''),
        csvEscape(t.billingContactEmail ?? ''),
        csvEscape(t.billingPhoneNumber ?? ''),
        csvEscape(t.paymentMethod),
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
      ].join(','),
    );
  }
  return lines.join('\r\n');
}

/**
 * CSV のエスケープ。カンマ・改行・ダブルクォートを含む値はダブルクォートで囲み、
 * 内部のダブルクォートは 2 連続にする (RFC 4180)。
 */
function csvEscape(value: string): string {
  if (value === '') return '';
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

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

const HEADERS = [
  'テナント連番',
  'テナント名',
  'プラン',
  'API呼出回数',
  'API課金額(円)',
  'アクティブユーザ数',
  '月次予算上限(円)',
];

function buildCurrentMonthCsv(tenants: Awaited<ReturnType<typeof listAllTenants>>): string {
  const lines = [HEADERS.join(',')];
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
      ].join(','),
    );
  }
  return lines.join('\r\n');
}

function buildHistoryCsv(rows: Awaited<ReturnType<typeof listMonthlyUsageHistory>>): string {
  const lines = [HEADERS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.tenantSeq?.toString() ?? '',
        csvEscape(r.tenantName),
        csvEscape(r.plan),
        r.apiCallCount.toString(),
        r.apiCostJpy.toString(),
        r.activeUserCount.toString(),
        // 履歴テーブルには monthlyBudgetCapJpy 列がない (請求書根拠としての必要性が低い)
        '',
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

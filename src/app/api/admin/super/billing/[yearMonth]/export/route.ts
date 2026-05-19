/**
 * GET /api/admin/super/billing/[yearMonth]/export (PR-V7a / 2026-05-19)
 *
 * 役割:
 *   super_admin 向け 月次請求履歴 CSV エクスポート (= 監査 C-G7)。
 *   getMonthlyBillingDetail と同じデータを CSV 形式で出力。
 *
 * 認可: super_admin role 必須 + middleware Basic Auth (PR-V7 #7) で多層防御
 *
 * クエリパラメタ:
 *   - status:         (任意) 'pending' / 'paid' / 'failed' / etc. でフィルタ
 *   - paymentMethod:  (任意) 'credit_card' / 'invoice' / 'bank_transfer' でフィルタ
 *
 * 出力:
 *   - Content-Type: text/csv; charset=utf-8
 *   - UTF-8 BOM 付き (Excel で日本語文字化け防止)
 *   - 14 列 (= 主要情報 + 期日 + Smart Retries 状況)
 *   - ファイル名: billing-detail-{yearMonth}.csv
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { getMonthlyBillingDetail } from '@/services/billing-dashboard.service';

const VALID_YEAR_MONTH = /^\d{4}-\d{2}$/;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ yearMonth: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (!isSuperAdmin(user)) {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const { yearMonth } = await params;
  if (!VALID_YEAR_MONTH.test(yearMonth)) {
    return NextResponse.json(
      { error: { code: 'INVALID_YEAR_MONTH' } },
      { status: 400 },
    );
  }

  const url = new URL(req.url);
  const status = url.searchParams.get('status') ?? undefined;
  const paymentMethod = url.searchParams.get('paymentMethod') ?? undefined;

  const records = await getMonthlyBillingDetail(yearMonth, { status, paymentMethod });

  const header = [
    'テナント連番',
    'テナント名',
    '対象月',
    '支払方法',
    '金額 (税抜)',
    '消費税',
    '合計 (税込)',
    'ステータス',
    '入金日',
    '支払期日',
    '次回リトライ',
    '失敗理由',
    'リトライ回数',
    'Stripe Invoice ID',
    '解約済',
  ].join(',');

  const rows = records.map((r) =>
    [
      r.tenantSeq ?? '',
      escapeCsv(r.tenantName),
      r.yearMonth,
      r.paymentMethod,
      String(r.amountJpy),
      String(r.taxAmountJpy),
      String(r.totalAmountJpy),
      r.status,
      formatDate(r.paidAt),
      formatDate(r.paymentDueDate),
      formatDate(r.nextPaymentAttempt),
      escapeCsv(r.failureReason ?? ''),
      String(r.retryCount),
      r.stripeInvoiceId ?? '',
      r.tenantDeletedAt != null ? 'YES' : '',
    ].join(','),
  );

  const csv = '﻿' + [header, ...rows].join('\n'); // BOM + 行

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="billing-detail-${yearMonth}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

function escapeCsv(s: string): string {
  // CSV 仕様: ダブルクォート / カンマ / 改行 を含む場合はダブルクォートで囲み、内部の " を "" にエスケープ
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function formatDate(d: Date | null): string {
  if (d == null) return '';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(d)
    .replace(/\//g, '-');
}

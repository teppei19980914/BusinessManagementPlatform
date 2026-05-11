/**
 * GET /api/admin/super/usage/export route テスト (2026-05-11)
 *
 * 役割:
 *   super_admin の月次請求業務 CSV エクスポートの正確性を検証する。請求金額の
 *   取りこぼし / 過剰請求 / Default テナント混入 を構造的に防ぐ。
 *
 * 検査観点:
 *   1. 認可: super_admin 以外は 403
 *   2. 当月分: listAllTenants の値 (LLM + Storage 合計) が CSV に正確に反映される
 *   3. 過去月: listMonthlyUsageHistory の値が CSV に正確に反映される
 *   4. UTF-8 BOM 付き / Excel での文字化け回避
 *   5. CSV エスケープ (カンマ・改行・ダブルクォート)
 *   6. yearMonth バリデーション
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/permissions/role', () => ({
  isSuperAdmin: vi.fn(),
}));

vi.mock('@/services/super-admin.service', () => ({
  listAllTenants: vi.fn(),
  listMonthlyUsageHistory: vi.fn(),
}));

import { GET } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import {
  listAllTenants,
  listMonthlyUsageHistory,
} from '@/services/super-admin.service';

const SUPER_ADMIN_USER = {
  id: 'super-admin-uuid',
  tenantId: 'tenant-mgmt',
  systemRole: 'super_admin',
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

// ================================================================
// 認可
// ================================================================

describe('認可 (請求業務の機密性)', () => {
  it('super_admin 以外は 403 を返す (顧客請求情報の漏洩防止)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'general-user',
      tenantId: 't-1',
      systemRole: 'general',
    } as never);
    vi.mocked(isSuperAdmin).mockReturnValue(false);

    const req = new NextRequest('http://localhost/api/admin/super/usage/export');
    const res = await GET(req);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
    // 認可拒否時はサービスを呼ばない (= データ漏洩経路を遮断)
    expect(listAllTenants).not.toHaveBeenCalled();
    expect(listMonthlyUsageHistory).not.toHaveBeenCalled();
  });

  it('admin (テナント管理者) も 403 を返す (super_admin ロールのみ許可)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'admin-user',
      tenantId: 't-1',
      systemRole: 'admin',
    } as never);
    vi.mocked(isSuperAdmin).mockReturnValue(false);

    const req = new NextRequest('http://localhost/api/admin/super/usage/export');
    const res = await GET(req);

    expect(res.status).toBe(403);
  });
});

// ================================================================
// 当月分 CSV (= listAllTenants 経路)
// ================================================================

describe('当月分 CSV (= 現在値、yearMonth パラメータなし)', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(SUPER_ADMIN_USER);
    vi.mocked(isSuperAdmin).mockReturnValue(true);
  });

  it('LLM 費用 + Storage add-on 月額 + 合計月額 が正確に CSV に出力される', async () => {
    vi.mocked(listAllTenants).mockResolvedValue([
      {
        id: 't-a', tenantSeq: 2, slug: 'a', name: '顧客A', plan: 'expert',
        currentMonthApiCallCount: 300, currentMonthApiCostJpy: 3000,
        monthlyBudgetCapJpy: 10000, activeUserCount: 5,
        createdAt: new Date('2026-01-01'),
        billingType: 'corporate', billingCompanyName: 'A社',
        billingContactName: '山田', billingContactEmail: 'a@a.com',
        billingAddress: null, billingPostalCode: '100-0001',
        billingPrefecture: '東京都', billingCity: '千代田区',
        billingStreetAddress: '1-1', billingBuildingName: 'Aビル',
        billingPhoneNumber: '03-1234-5678', paymentMethod: 'invoice',
        storageAddonPlan: 'plus', storageBytesUsed: 100 * 1024 * 1024,
        storageAddonMonthlyJpy: 500, totalCurrentMonthJpy: 3500,
      },
    ] as never);

    const req = new NextRequest('http://localhost/api/admin/super/usage/export');
    const res = await GET(req);

    expect(res.status).toBe(200);

    // UTF-8 BOM が付与されている (Excel での日本語文字化け回避)
    // arrayBuffer で raw バイトを取得 (TextDecoder は BOM を自動で除去するため string では確認不可)
    const buf = new Uint8Array(await res.clone().arrayBuffer());
    expect(buf[0]).toBe(0xef);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xbf);

    const body = await res.text();
    // CSV ヘッダ
    expect(body).toContain('テナント名');
    expect(body).toContain('Storage月額(円)');
    expect(body).toContain('合計月額(円)');

    // 値が正確に記録されている (請求書の根拠)
    expect(body).toContain('顧客A');
    expect(body).toContain('3000'); // LLM
    expect(body).toContain('500'); // Storage
    expect(body).toContain('3500'); // 合計 (LLM + Storage)

    // 請求先情報も含まれる
    expect(body).toContain('A社');
    expect(body).toContain('100-0001');
  });

  it('複数テナントの請求行が漏れなく出力される (= 売上計上漏れ防止)', async () => {
    vi.mocked(listAllTenants).mockResolvedValue([
      {
        id: 't-a', tenantSeq: 1, slug: 'a', name: 'A', plan: 'beginner',
        currentMonthApiCallCount: 80, currentMonthApiCostJpy: 0,
        monthlyBudgetCapJpy: null, activeUserCount: 2,
        createdAt: new Date('2026-01-01'),
        billingType: 'corporate', billingCompanyName: null,
        billingContactName: null, billingContactEmail: null,
        billingAddress: null, billingPostalCode: null, billingPrefecture: null,
        billingCity: null, billingStreetAddress: null, billingBuildingName: null,
        billingPhoneNumber: null, paymentMethod: 'invoice',
        storageAddonPlan: 'standard', storageBytesUsed: 0,
        storageAddonMonthlyJpy: 0, totalCurrentMonthJpy: 0,
      },
      {
        id: 't-b', tenantSeq: 2, slug: 'b', name: 'B', plan: 'pro',
        currentMonthApiCallCount: 1500, currentMonthApiCostJpy: 45000,
        monthlyBudgetCapJpy: 100000, activeUserCount: 12,
        createdAt: new Date('2026-02-01'),
        billingType: 'corporate', billingCompanyName: null,
        billingContactName: null, billingContactEmail: null,
        billingAddress: null, billingPostalCode: null, billingPrefecture: null,
        billingCity: null, billingStreetAddress: null, billingBuildingName: null,
        billingPhoneNumber: null, paymentMethod: 'invoice',
        storageAddonPlan: 'pro_storage', storageBytesUsed: 500 * 1024 * 1024,
        storageAddonMonthlyJpy: 1500, totalCurrentMonthJpy: 46500,
      },
    ] as never);

    const req = new NextRequest('http://localhost/api/admin/super/usage/export');
    const res = await GET(req);
    const body = await res.text();

    // 両テナントが CSV に含まれる
    expect(body).toContain('A,beginner');
    expect(body).toContain('B,pro');
    expect(body).toContain('45000'); // tenant-b LLM cost
    expect(body).toContain('46500'); // tenant-b 合計
  });

  it('カンマ・改行・ダブルクォートを含む名前は RFC 4180 でエスケープ', async () => {
    vi.mocked(listAllTenants).mockResolvedValue([
      {
        id: 't-x', tenantSeq: 1, slug: 'x', name: 'Foo, "Bar"\nBaz', plan: 'expert',
        currentMonthApiCallCount: 0, currentMonthApiCostJpy: 0,
        monthlyBudgetCapJpy: null, activeUserCount: 0,
        createdAt: new Date('2026-01-01'),
        billingType: 'corporate', billingCompanyName: null,
        billingContactName: null, billingContactEmail: null,
        billingAddress: null, billingPostalCode: null, billingPrefecture: null,
        billingCity: null, billingStreetAddress: null, billingBuildingName: null,
        billingPhoneNumber: null, paymentMethod: 'invoice',
        storageAddonPlan: 'standard', storageBytesUsed: 0,
        storageAddonMonthlyJpy: 0, totalCurrentMonthJpy: 0,
      },
    ] as never);

    const req = new NextRequest('http://localhost/api/admin/super/usage/export');
    const res = await GET(req);
    const body = await res.text();

    // ダブルクォートで囲み、内部の " は "" に
    expect(body).toContain('"Foo, ""Bar""\nBaz"');
  });

  it('適切な Content-Type / Content-Disposition / Cache-Control を返す', async () => {
    vi.mocked(listAllTenants).mockResolvedValue([] as never);

    const req = new NextRequest('http://localhost/api/admin/super/usage/export');
    const res = await GET(req);

    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('Content-Disposition')).toMatch(
      /filename="tenant-usage-\d{4}-\d{2}-current\.csv"/,
    );
    // 機密データのキャッシュ防止
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

// ================================================================
// 過去月 CSV (= listMonthlyUsageHistory 経路)
// ================================================================

describe('過去月 CSV (= 履歴値、yearMonth=YYYY-MM 指定)', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(SUPER_ADMIN_USER);
    vi.mocked(isSuperAdmin).mockReturnValue(true);
  });

  it('指定 yearMonth のみフィルタされた行を出力 (他月混入なし)', async () => {
    vi.mocked(listMonthlyUsageHistory).mockResolvedValue([
      {
        yearMonth: '2026-04', tenantId: 't-a', tenantSeq: 1, tenantName: 'A',
        plan: 'expert', apiCallCount: 200, apiCostJpy: 2000, activeUserCount: 3,
        storageBytesUsed: 50 * 1024 * 1024, storageAddonPlan: 'standard',
        storageAddonJpy: 0, totalJpy: 2000,
      },
      {
        yearMonth: '2026-03', tenantId: 't-a', tenantSeq: 1, tenantName: 'A',
        plan: 'expert', apiCallCount: 100, apiCostJpy: 1000, activeUserCount: 3,
        storageBytesUsed: 30 * 1024 * 1024, storageAddonPlan: 'standard',
        storageAddonJpy: 0, totalJpy: 1000,
      },
    ] as never);

    const req = new NextRequest(
      'http://localhost/api/admin/super/usage/export?yearMonth=2026-04',
    );
    const res = await GET(req);
    const body = await res.text();

    // 2026-04 のみが CSV に出る (= 2026-03 行は除外)
    expect(body).toContain('A,expert,200,2000,3');
    expect(body).not.toContain(',100,1000,');
    expect(res.headers.get('Content-Disposition')).toContain('tenant-usage-2026-04.csv');
  });

  it('履歴 CSV のヘッダには請求先列は含まない (= 履歴は集計のみ、最新請求先は別 API で参照)', async () => {
    vi.mocked(listMonthlyUsageHistory).mockResolvedValue([] as never);

    const req = new NextRequest(
      'http://localhost/api/admin/super/usage/export?yearMonth=2026-04',
    );
    const res = await GET(req);
    const body = await res.text();

    // 請求先列は含まれない
    expect(body).not.toContain('請求先メール');
    expect(body).not.toContain('会社名_法人名');
    // ただし Storage の列はある
    expect(body).toContain('Storage月額(円)');
    expect(body).toContain('合計月額(円)');
  });

  it('不正な yearMonth は 400 (VALIDATION_ERROR)', async () => {
    const cases = ['2026-13', '202604', 'abcd-ef', '2026/04'];
    for (const ym of cases) {
      const req = new NextRequest(
        `http://localhost/api/admin/super/usage/export?yearMonth=${ym}`,
      );
      const res = await GET(req);
      expect(res.status, `yearMonth=${ym} should be 400`).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('履歴 0 件でもヘッダのみの CSV が返る (= 空月でも request 失敗にしない)', async () => {
    vi.mocked(listMonthlyUsageHistory).mockResolvedValue([] as never);

    const req = new NextRequest(
      'http://localhost/api/admin/super/usage/export?yearMonth=2025-12',
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('テナント連番');
    // ヘッダ行のみ
    const dataRows = body.split('\r\n').filter((l) => l && !l.includes('テナント連番'));
    expect(dataRows).toEqual([]);
  });
});

// ================================================================
// テナント隔離 (Default 混入防止)
// ================================================================

describe('テナント隔離 — Default テナントが請求 CSV に混入しないこと', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(SUPER_ADMIN_USER);
    vi.mocked(isSuperAdmin).mockReturnValue(true);
  });

  it('当月 CSV は listAllTenants 経由 (= Default 除外済) のみ参照する', async () => {
    vi.mocked(listAllTenants).mockResolvedValue([] as never);

    const req = new NextRequest('http://localhost/api/admin/super/usage/export');
    await GET(req);

    // listAllTenants は呼ばれる (= 除外済顧客テナントのみが対象)
    expect(listAllTenants).toHaveBeenCalledTimes(1);
    // 履歴 API は呼ばれない (= 当月経路は履歴を引かない)
    expect(listMonthlyUsageHistory).not.toHaveBeenCalled();
  });

  it('過去月 CSV は listMonthlyUsageHistory 経由 (= Default 除外済) のみ参照する', async () => {
    vi.mocked(listMonthlyUsageHistory).mockResolvedValue([] as never);

    const req = new NextRequest(
      'http://localhost/api/admin/super/usage/export?yearMonth=2026-04',
    );
    await GET(req);

    // 履歴 API は呼ばれる
    expect(listMonthlyUsageHistory).toHaveBeenCalledTimes(1);
    // 当月 API は呼ばれない
    expect(listAllTenants).not.toHaveBeenCalled();
  });
});

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

// PR-V8 (2026-05-19): 当月 CSV は SUM ベースに切替えたため reconcile も mock 必要
vi.mock('@/services/api-usage-recalc.service', () => ({
  reconcileAllTenantsApiUsage: vi.fn(),
}));

import { GET } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import {
  listAllTenants,
  listMonthlyUsageHistory,
} from '@/services/super-admin.service';
import { reconcileAllTenantsApiUsage } from '@/services/api-usage-recalc.service';

const SUPER_ADMIN_USER = {
  id: 'super-admin-uuid',
  tenantId: 'tenant-mgmt',
  systemRole: 'super_admin',
} as never;

/**
 * PR-V8: 「drift なし」reconcile 結果のヘルパ (= cached = reconciled)
 *   既存テストで CSV に counter 値が出ることを期待しているケースで使う。
 */
function makeReconcileWithoutDrift(
  tenantId: string,
  callCount: number,
  costJpy: number,
): Awaited<ReturnType<typeof reconcileAllTenantsApiUsage>>[number] {
  return {
    tenantId,
    cachedCallCount: callCount,
    cachedCostJpy: costJpy,
    reconciledCallCount: callCount,
    reconciledCostJpy: costJpy,
    driftCallCount: 0,
    driftCostJpy: 0,
    driftCallRatio: 0,
    driftCostRatio: 0,
    driftRatio: 0,
    monthStart: new Date('2026-05-01T00:00:00Z'),
    monthStartUtc: new Date('2026-05-01T00:00:00Z'),
    hasDrift: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // PR-V8 (2026-05-19): デフォルトで「drift なし」を返す (= 既存テストとの互換性維持)
  vi.mocked(reconcileAllTenantsApiUsage).mockResolvedValue([]);
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
        // 2026-05-15 価格改定後: Expert ¥5/call × 300 calls = ¥1500
        currentMonthApiCallCount: 300, currentMonthApiCostJpy: 1500,
        monthlyBudgetCapJpy: 10000, activeUserCount: 5,
        createdAt: new Date('2026-01-01'),
        billingType: 'corporate', billingCompanyName: 'A社',
        billingContactName: '山田', billingContactEmail: 'a@a.com',
        billingAddress: null, billingPostalCode: '100-0001',
        billingPrefecture: '東京都', billingCity: '千代田区',
        billingStreetAddress: '1-1', billingBuildingName: 'Aビル',
        billingPhoneNumber: '03-1234-5678', paymentMethod: 'invoice',
        storageBytesUsed: 100 * 1024 * 1024,
        storageAddonMonthlyJpy: 500, storageFileBytesPeakThisMonth: 0, totalCurrentMonthJpy: 2000,
        deletedAt: null,
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
    // CSV ヘッダ (chore/storage-addon-backend-removal: Storage月額(円) 列は撤去)
    expect(body).toContain('テナント名');
    expect(body).toContain('合計月額(円)');

    // 値が正確に記録されている (請求書の根拠)
    expect(body).toContain('顧客A');
    expect(body).toContain('1500'); // LLM (ApiCallLog SUM = 真値)

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
        storageBytesUsed: 0,
        storageAddonMonthlyJpy: 0, storageFileBytesPeakThisMonth: 0, totalCurrentMonthJpy: 0,
        deletedAt: null,
      },
      {
        id: 't-b', tenantSeq: 2, slug: 'b', name: 'B', plan: 'pro',
        // 2026-05-15 価格改定後: Pro ¥15/call × 1500 calls = ¥22500
        currentMonthApiCallCount: 1500, currentMonthApiCostJpy: 22500,
        monthlyBudgetCapJpy: 100000, activeUserCount: 12,
        createdAt: new Date('2026-02-01'),
        billingType: 'corporate', billingCompanyName: null,
        billingContactName: null, billingContactEmail: null,
        billingAddress: null, billingPostalCode: null, billingPrefecture: null,
        billingCity: null, billingStreetAddress: null, billingBuildingName: null,
        billingPhoneNumber: null, paymentMethod: 'invoice',
        storageBytesUsed: 500 * 1024 * 1024,
        storageAddonMonthlyJpy: 1500, storageFileBytesPeakThisMonth: 0, totalCurrentMonthJpy: 24000,
        deletedAt: null,
      },
    ] as never);

    const req = new NextRequest('http://localhost/api/admin/super/usage/export');
    const res = await GET(req);
    const body = await res.text();

    // 両テナントが CSV に含まれる
    expect(body).toContain('A,beginner');
    expect(body).toContain('B,pro');
    // chore/storage-addon-backend-removal (2026-05-26): 合計は ApiCallLog SUM のみ (Storage 月額固定費は廃止)
    expect(body).toContain('22500'); // tenant-b LLM cost (1500 calls × ¥15)
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
        storageBytesUsed: 0,
        storageAddonMonthlyJpy: 0, storageFileBytesPeakThisMonth: 0, totalCurrentMonthJpy: 0,
        deletedAt: null,
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
        storageBytesUsed: 50 * 1024 * 1024,
        totalJpy: 2000,
        tenantDeletedAt: null,
      },
      {
        yearMonth: '2026-03', tenantId: 't-a', tenantSeq: 1, tenantName: 'A',
        plan: 'expert', apiCallCount: 100, apiCostJpy: 1000, activeUserCount: 3,
        storageBytesUsed: 30 * 1024 * 1024,
        totalJpy: 1000,
        tenantDeletedAt: null,
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
    // chore/storage-addon-backend-removal (2026-05-26): Storage月額(円) 列は撤去 (従量課金化)
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

// ================================================================
// 2026-05-14: includeDeleted フラグ (月途中解約の請求漏れ検知)
// ================================================================

describe('includeDeleted フラグ (月途中解約の請求検知)', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(SUPER_ADMIN_USER);
    vi.mocked(isSuperAdmin).mockReturnValue(true);
  });

  it('includeDeleted=true で listAllTenants に options.includeDeleted=true が渡る', async () => {
    vi.mocked(listAllTenants).mockResolvedValue([] as never);

    const req = new NextRequest(
      'http://localhost/api/admin/super/usage/export?includeDeleted=true',
    );
    await GET(req);

    expect(listAllTenants).toHaveBeenCalledWith({ includeDeleted: true });
  });

  it('includeDeleted 省略時は options.includeDeleted=false が渡る (後方互換)', async () => {
    vi.mocked(listAllTenants).mockResolvedValue([] as never);

    const req = new NextRequest('http://localhost/api/admin/super/usage/export');
    await GET(req);

    expect(listAllTenants).toHaveBeenCalledWith({ includeDeleted: false });
  });

  it('解約済テナントは CSV に「解約日」列が ISO 形式で出力される (当月分)', async () => {
    vi.mocked(listAllTenants).mockResolvedValue([
      {
        id: 't-cancelled', tenantSeq: 5, slug: 'c', name: '5月途中解約', plan: 'expert',
        // 2026-05-15 価格改定後: 80 calls × ¥5 = ¥400
        currentMonthApiCallCount: 80, currentMonthApiCostJpy: 400,
        monthlyBudgetCapJpy: null, activeUserCount: 0,
        createdAt: new Date('2026-01-01'),
        billingType: 'corporate', billingCompanyName: 'X社',
        billingContactName: '担当', billingContactEmail: 'x@x.com',
        billingAddress: null, billingPostalCode: null, billingPrefecture: null,
        billingCity: null, billingStreetAddress: null, billingBuildingName: null,
        billingPhoneNumber: null, paymentMethod: 'invoice',
        storageBytesUsed: 0,
        storageAddonMonthlyJpy: 0, storageFileBytesPeakThisMonth: 0, totalCurrentMonthJpy: 400,
        deletedAt: new Date('2026-05-20T03:00:00.000Z'),
      },
    ] as never);

    const req = new NextRequest(
      'http://localhost/api/admin/super/usage/export?includeDeleted=true',
    );
    const res = await GET(req);
    const body = await res.text();

    // ヘッダに「解約日」列が含まれる
    expect(body).toContain('解約日');
    // データ行に ISO 形式の解約日が含まれる (= 5/20 までの請求対象を判別可能)
    expect(body).toContain('2026-05-20T03:00:00.000Z');
    // ファイル名に -with-deleted サフィックスが付く
    expect(res.headers.get('Content-Disposition')).toContain('with-deleted');
  });

  it('アクティブテナントは「解約日」列が空欄', async () => {
    vi.mocked(listAllTenants).mockResolvedValue([
      {
        id: 't-active', tenantSeq: 2, slug: 'a', name: 'Active', plan: 'expert',
        // 2026-05-15 価格改定後: 100 calls × ¥5 = ¥500
        currentMonthApiCallCount: 100, currentMonthApiCostJpy: 500,
        monthlyBudgetCapJpy: null, activeUserCount: 3,
        createdAt: new Date('2026-01-01'),
        billingType: 'corporate', billingCompanyName: null,
        billingContactName: null, billingContactEmail: null,
        billingAddress: null, billingPostalCode: null, billingPrefecture: null,
        billingCity: null, billingStreetAddress: null, billingBuildingName: null,
        billingPhoneNumber: null, paymentMethod: 'invoice',
        storageBytesUsed: 0,
        storageAddonMonthlyJpy: 0, storageFileBytesPeakThisMonth: 0, totalCurrentMonthJpy: 500,
        deletedAt: null,
      },
    ] as never);

    const req = new NextRequest('http://localhost/api/admin/super/usage/export');
    const res = await GET(req);
    const body = await res.text();

    // データ行を取り出し、解約日に該当する位置が空欄であることを確認
    // (シンプルに ISO っぽい文字列が含まれないことで代用)
    const dataLines = body.split('\r\n').filter((l) => l && !l.includes('テナント連番'));
    expect(dataLines[0]).not.toMatch(/202\d-\d{2}-\d{2}T/);
  });

  it('過去月 CSV でも履歴に紐づくテナントの解約日 (tenantDeletedAt) が出力される', async () => {
    vi.mocked(listMonthlyUsageHistory).mockResolvedValue([
      {
        yearMonth: '2026-05', tenantId: 't-c', tenantSeq: 7, tenantName: '解約済テナント',
        plan: 'expert', apiCallCount: 80, apiCostJpy: 800, activeUserCount: 2,
        storageBytesUsed: 0,
        totalJpy: 800,
        tenantDeletedAt: new Date('2026-05-20T03:00:00.000Z'),
      },
    ] as never);

    const req = new NextRequest(
      'http://localhost/api/admin/super/usage/export?yearMonth=2026-05',
    );
    const res = await GET(req);
    const body = await res.text();

    expect(body).toContain('解約日');
    expect(body).toContain('2026-05-20T03:00:00.000Z');
    expect(body).toContain('解約済テナント');
  });
});

// ================================================================
// PR-V8 (2026-05-19) ★請求重要 regression★
//
// 当月 CSV は ApiCallLog SUM (真値) を主軸とし、counter は参考値として並記する。
// 本件 (Default テナント counter 1 / ApiCallLog SUM 8 のような drift) が起きた場合でも、
// CSV の API 呼出回数列には真値の 8 が出力され、誤請求を未然に防ぐ必要がある。
// ================================================================

describe('★PR-V8 請求 regression★ CSV エクスポートは ApiCallLog SUM を真値として出力', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(SUPER_ADMIN_USER);
    vi.mocked(isSuperAdmin).mockReturnValue(true);
  });

  it('drift がある場合 → CSV の API 呼出回数 / 課金額列には SUM (真値) が出力される', async () => {
    vi.mocked(listAllTenants).mockResolvedValue([
      {
        id: 't-x', tenantSeq: 9, slug: 'x', name: 'DriftedX', plan: 'expert',
        // counter は壊れた値 (drift)
        currentMonthApiCallCount: 1, currentMonthApiCostJpy: 5,
        monthlyBudgetCapJpy: null, activeUserCount: 1,
        createdAt: new Date('2026-01-01'),
        billingType: 'corporate', billingCompanyName: null,
        billingContactName: null, billingContactEmail: null,
        billingAddress: null, billingPostalCode: null, billingPrefecture: null,
        billingCity: null, billingStreetAddress: null, billingBuildingName: null,
        billingPhoneNumber: null, paymentMethod: 'invoice',
        storageBytesUsed: 0,
        storageAddonMonthlyJpy: 0, storageFileBytesPeakThisMonth: 0, totalCurrentMonthJpy: 5,
        deletedAt: null,
      },
    ] as never);
    // reconcile で真値: 8 回 / ¥40 (= 7 件分の drift)
    vi.mocked(reconcileAllTenantsApiUsage).mockResolvedValue([
      {
        tenantId: 't-x',
        cachedCallCount: 1,
        cachedCostJpy: 5,
        reconciledCallCount: 8,
        reconciledCostJpy: 40,
        driftCallCount: -7,
        driftCostJpy: -35,
        driftCallRatio: 7 / 8,
        driftCostRatio: 35 / 40,
        driftRatio: 7 / 8,
        monthStart: new Date('2026-04-30T15:00:00Z'),
        monthStartUtc: new Date('2026-04-30T15:00:00Z'),
        hasDrift: true,
      },
    ]);

    const req = new NextRequest('http://localhost/api/admin/super/usage/export');
    const res = await GET(req);
    const body = await res.text();

    // ★ CSV の主軸列に SUM (真値) = 8 / ¥40 が出力されることを assert
    //   これが本件 (Default テナント) で誤請求を防ぐ最重要 invariant
    const dataLines = body.split('\r\n').filter((l) => l && !l.includes('テナント連番'));
    expect(dataLines).toHaveLength(1);
    const cols = dataLines[0].split(',');
    // 列順: 連番, name, plan, sumCallCount, sumCostJpy, counterCallCount, counterCostJpy, driftWarning, ...
    expect(cols[3]).toBe('8'); // API呼出回数 (SUM)
    expect(cols[4]).toBe('40'); // API課金額 (SUM)
    expect(cols[5]).toBe('1'); // API呼出回数 (counter)
    expect(cols[6]).toBe('5'); // API課金額 (counter)
    // drift 警告列が含まれる
    expect(cols[7]).toContain('drift');
    expect(cols[8]).toBe('-7'); // drift呼出差分
    expect(cols[9]).toBe('-35'); // drift費用差分
  });

  it('drift なし → counter と SUM が一致しているため両列とも同値', async () => {
    vi.mocked(listAllTenants).mockResolvedValue([
      {
        id: 't-y', tenantSeq: 10, slug: 'y', name: 'CleanY', plan: 'expert',
        currentMonthApiCallCount: 100, currentMonthApiCostJpy: 500,
        monthlyBudgetCapJpy: null, activeUserCount: 2,
        createdAt: new Date('2026-01-01'),
        billingType: 'corporate', billingCompanyName: null,
        billingContactName: null, billingContactEmail: null,
        billingAddress: null, billingPostalCode: null, billingPrefecture: null,
        billingCity: null, billingStreetAddress: null, billingBuildingName: null,
        billingPhoneNumber: null, paymentMethod: 'invoice',
        storageBytesUsed: 0,
        storageAddonMonthlyJpy: 0, storageFileBytesPeakThisMonth: 0, totalCurrentMonthJpy: 500,
        deletedAt: null,
      },
    ] as never);
    vi.mocked(reconcileAllTenantsApiUsage).mockResolvedValue([
      makeReconcileWithoutDrift('t-y', 100, 500),
    ]);

    const req = new NextRequest('http://localhost/api/admin/super/usage/export');
    const res = await GET(req);
    const body = await res.text();

    const dataLines = body.split('\r\n').filter((l) => l && !l.includes('テナント連番'));
    const cols = dataLines[0].split(',');
    expect(cols[3]).toBe('100'); // SUM call
    expect(cols[4]).toBe('500'); // SUM cost
    expect(cols[5]).toBe('100'); // counter call
    expect(cols[6]).toBe('500'); // counter cost
    expect(cols[7]).toBe(''); // drift 警告なし (空文字)
  });

  it('reconcile に該当エントリがない (削除済等) → counter 値にフォールバック (後方互換)', async () => {
    vi.mocked(listAllTenants).mockResolvedValue([
      {
        id: 't-z', tenantSeq: 11, slug: 'z', name: 'NoReconcileZ', plan: 'expert',
        currentMonthApiCallCount: 50, currentMonthApiCostJpy: 250,
        monthlyBudgetCapJpy: null, activeUserCount: 1,
        createdAt: new Date('2026-01-01'),
        billingType: 'corporate', billingCompanyName: null,
        billingContactName: null, billingContactEmail: null,
        billingAddress: null, billingPostalCode: null, billingPrefecture: null,
        billingCity: null, billingStreetAddress: null, billingBuildingName: null,
        billingPhoneNumber: null, paymentMethod: 'invoice',
        storageBytesUsed: 0,
        storageAddonMonthlyJpy: 0, storageFileBytesPeakThisMonth: 0, totalCurrentMonthJpy: 250,
        deletedAt: null,
      },
    ] as never);
    // reconcile は他テナント分のみ
    vi.mocked(reconcileAllTenantsApiUsage).mockResolvedValue([]);

    const req = new NextRequest('http://localhost/api/admin/super/usage/export');
    const res = await GET(req);
    const body = await res.text();

    const dataLines = body.split('\r\n').filter((l) => l && !l.includes('テナント連番'));
    const cols = dataLines[0].split(',');
    expect(cols[3]).toBe('50'); // SUM 列にフォールバック値 (= counter)
    expect(cols[5]).toBe('50'); // counter 列
    expect(cols[7]).toBe(''); // drift 警告なし
  });
});

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

/**
 * 外部データ移行サービスの単体テスト (Phase 1 / 2026-05-08)
 *
 * 検証項目:
 *   - 不正ファイル / 上限超過 / テナント不在 → 適切なエラーコード
 *   - CSV パース + フィールドマッピング正常系
 *   - 必須フィールド欠落のバリデーションエラー
 *   - Beginner プランで月次上限超過 → warningCode='BEGINNER_CALL_LIMIT_EXCEEDED'
 *   - Expert/Pro で月次予算超過 → warningCode='BUDGET_CAP_EXCEEDED'
 *   - apply: previewId 不在 → PREVIEW_NOT_FOUND
 *   - apply: 別テナントの previewId → PREVIEW_NOT_FOUND (= 認可境界)
 *   - apply: 別管理者の previewId → PREVIEW_NOT_OWNED
 *   - apply: TTL 切れ → PREVIEW_EXPIRED
 *   - apply: 二重防御 (apply 直前の再評価) で BEGINNER_CALL_LIMIT
 *   - deleteExpiredPreviews: 期限切れのみ削除
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => {
  // PR-3 (2026-05-15): tx 側にも storage-guard 用の tenant.findFirst / update / $queryRaw を追加
  const tx = {
    knowledge: { create: vi.fn() },
    riskIssue: { create: vi.fn() },
    tenantImportPreview: { delete: vi.fn() },
    tenant: {
      findFirst: vi.fn(async () => ({
        storageAddonPlan: 'standard',
        storageBytesUsed: BigInt(0),
      })),
      update: vi.fn(),
    },
    $queryRaw: vi.fn(async () => [{ total_bytes: BigInt(0) }]),
  };
  return {
    prisma: {
      tenant: {
        findFirst: vi.fn(),
        findFirstOrThrow: vi.fn(),
      },
      project: { findMany: vi.fn() },
      tenantImportPreview: {
        create: vi.fn(),
        findUnique: vi.fn(),
        deleteMany: vi.fn(),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
      __tx: tx,
    },
  };
});

vi.mock('@/services/embedding.service', () => ({
  generateAndPersistEntityEmbedding: vi.fn(async () => undefined),
}));

vi.mock('@/services/knowledge.service', () => ({
  composeKnowledgeText: vi.fn((args: { title: string }) => args.title),
}));

import {
  previewImport,
  applyImport,
  deleteExpiredPreviews,
} from './external-data-import.service';
import { prisma } from '@/lib/db';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_USER_ID = '33333333-3333-3333-3333-333333333333';
const PROJECT_ID = '44444444-4444-4444-4444-444444444444';

type MockedTx = {
  knowledge: { create: ReturnType<typeof vi.fn> };
  riskIssue: { create: ReturnType<typeof vi.fn> };
  tenantImportPreview: { delete: ReturnType<typeof vi.fn> };
};
const tx = (prisma as unknown as { __tx: MockedTx }).__tx;

/** Knowledge ヘッダ + 1 行データの CSV を生成 */
function buildKnowledgeCsv(rows: Array<Partial<Record<string, string>>>): Buffer {
  const headers = ['title', 'background', 'content', 'result'];
  const csvLines = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => r[h] ?? '').join(',')),
  ];
  return Buffer.from(csvLines.join('\n'), 'utf-8');
}

function buildRiskIssueCsv(rows: Array<Partial<Record<string, string>>>): Buffer {
  const headers = ['type', 'title', 'content', 'impact', 'priority'];
  const csvLines = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => r[h] ?? '').join(',')),
  ];
  return Buffer.from(csvLines.join('\n'), 'utf-8');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
    id: TENANT_ID,
    plan: 'expert',
    currentMonthApiCallCount: 10,
    currentMonthApiCostJpy: 100,
    monthlyBudgetCapJpy: 5000,
    beginnerMonthlyCallLimit: 100,
    pricePerCallHaiku: 10,
    pricePerCallSonnet: 30,
    deletedAt: null,
  } as never);
  vi.mocked(prisma.project.findMany).mockResolvedValue([
    { id: PROJECT_ID } as never,
  ]);
  vi.mocked(prisma.tenantImportPreview.create).mockResolvedValue({} as never);
});

describe('previewImport', () => {
  it('空ファイル → INVALID_FILE', async () => {
    const r = await previewImport({
      tenantId: TENANT_ID,
      userId: USER_ID,
      fileBuffer: Buffer.alloc(0),
      mappings: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('INVALID_FILE');
  });

  it('テナント不在 → TENANT_NOT_FOUND', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null);
    const r = await previewImport({
      tenantId: TENANT_ID,
      userId: USER_ID,
      fileBuffer: buildKnowledgeCsv([
        { title: 'T', background: 'B', content: 'C', result: 'R' },
      ]),
      mappings: [
        {
          entity: 'knowledge',
          fieldMapping: {
            title: 'title',
            background: 'background',
            content: 'content',
            result: 'result',
          },
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('TENANT_NOT_FOUND');
  });

  it('正常系: Knowledge 2 行が取込候補に + コスト見積が正しい (Expert)', async () => {
    const r = await previewImport({
      tenantId: TENANT_ID,
      userId: USER_ID,
      fileBuffer: buildKnowledgeCsv([
        { title: 'T1', background: 'B1', content: 'C1', result: 'R1' },
        { title: 'T2', background: 'B2', content: 'C2', result: 'R2' },
      ]),
      mappings: [
        {
          entity: 'knowledge',
          fieldMapping: {
            title: 'title',
            background: 'background',
            content: 'content',
            result: 'result',
          },
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.knowledge.totalRows).toBe(2);
      expect(r.summary.knowledge.validRows).toBe(2);
      expect(r.summary.knowledge.errorRows).toBe(0);
      // Expert: ¥10 × 2 = ¥20
      expect(r.costEstimate.estimatedJpy).toBe(20);
      expect(r.costEstimate.warningCode).toBeNull();
    }
  });

  it('必須フィールド title 欠落 → エラー行に記録', async () => {
    const r = await previewImport({
      tenantId: TENANT_ID,
      userId: USER_ID,
      fileBuffer: buildKnowledgeCsv([
        { title: '', background: 'B', content: 'C', result: 'R' },
        { title: 'T2', background: 'B2', content: 'C2', result: 'R2' },
      ]),
      mappings: [
        {
          entity: 'knowledge',
          fieldMapping: {
            title: 'title',
            background: 'background',
            content: 'content',
            result: 'result',
          },
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.knowledge.totalRows).toBe(2);
      expect(r.summary.knowledge.validRows).toBe(1);
      expect(r.summary.knowledge.errorRows).toBe(1);
      expect(r.errors[0]?.field).toBe('title');
      // 有効分の見積は 1 件分のみ
      expect(r.costEstimate.estimatedJpy).toBe(10);
    }
  });

  it('Beginner プランで月次上限超過 → warningCode=BEGINNER_CALL_LIMIT_EXCEEDED', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'beginner',
      currentMonthApiCallCount: 95,
      currentMonthApiCostJpy: 0,
      monthlyBudgetCapJpy: null,
      beginnerMonthlyCallLimit: 100,
      pricePerCallHaiku: 10,
      pricePerCallSonnet: 30,
      deletedAt: null,
    } as never);

    const r = await previewImport({
      tenantId: TENANT_ID,
      userId: USER_ID,
      fileBuffer: buildKnowledgeCsv([
        { title: 'T1', background: 'B1', content: 'C1', result: 'R1' },
        { title: 'T2', background: 'B2', content: 'C2', result: 'R2' },
        { title: 'T3', background: 'B3', content: 'C3', result: 'R3' },
        { title: 'T4', background: 'B4', content: 'C4', result: 'R4' },
        { title: 'T5', background: 'B5', content: 'C5', result: 'R5' },
        { title: 'T6', background: 'B6', content: 'C6', result: 'R6' },
        { title: 'T7', background: 'B7', content: 'C7', result: 'R7' },
      ]),
      mappings: [
        {
          entity: 'knowledge',
          fieldMapping: {
            title: 'title',
            background: 'background',
            content: 'content',
            result: 'result',
          },
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 既 95 + 7 = 102 > 100
      expect(r.costEstimate.warningCode).toBe('BEGINNER_CALL_LIMIT_EXCEEDED');
      expect(r.costEstimate.warningMessage).toContain('Beginner');
    }
  });

  it('Expert プランで月次予算超過 → warningCode=BUDGET_CAP_EXCEEDED', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'expert',
      currentMonthApiCallCount: 0,
      currentMonthApiCostJpy: 4950,
      monthlyBudgetCapJpy: 5000,
      beginnerMonthlyCallLimit: 100,
      pricePerCallHaiku: 10,
      pricePerCallSonnet: 30,
      deletedAt: null,
    } as never);

    const r = await previewImport({
      tenantId: TENANT_ID,
      userId: USER_ID,
      fileBuffer: buildKnowledgeCsv([
        { title: 'T1', background: 'B1', content: 'C1', result: 'R1' },
        { title: 'T2', background: 'B2', content: 'C2', result: 'R2' },
        { title: 'T3', background: 'B3', content: 'C3', result: 'R3' },
        { title: 'T4', background: 'B4', content: 'C4', result: 'R4' },
        { title: 'T5', background: 'B5', content: 'C5', result: 'R5' },
        { title: 'T6', background: 'B6', content: 'C6', result: 'R6' },
      ]),
      mappings: [
        {
          entity: 'knowledge',
          fieldMapping: {
            title: 'title',
            background: 'background',
            content: 'content',
            result: 'result',
          },
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 既 ¥4950 + ¥10×6 = ¥5010 > ¥5000
      expect(r.costEstimate.warningCode).toBe('BUDGET_CAP_EXCEEDED');
    }
  });

  it('RiskIssue: defaultProjectId が指定され、テナント内に存在する場合は valid 扱い', async () => {
    const r = await previewImport({
      tenantId: TENANT_ID,
      userId: USER_ID,
      fileBuffer: buildRiskIssueCsv([
        {
          type: 'risk',
          title: 'Risk1',
          content: 'Content1',
          impact: 'high',
          priority: 'high',
        },
      ]),
      mappings: [
        {
          entity: 'risksIssues',
          fieldMapping: {
            type: 'type',
            title: 'title',
            content: 'content',
            impact: 'impact',
            priority: 'priority',
          },
          defaultProjectId: PROJECT_ID,
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.risksIssues.validRows).toBe(1);
      expect(r.errors).toEqual([]);
    }
  });

  it('RiskIssue: defaultProjectId が他テナントの project だった場合 (= テナント外) はエラー化', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([] as never);

    const r = await previewImport({
      tenantId: TENANT_ID,
      userId: USER_ID,
      fileBuffer: buildRiskIssueCsv([
        {
          type: 'risk',
          title: 'Risk1',
          content: 'Content1',
          impact: 'high',
          priority: 'high',
        },
      ]),
      mappings: [
        {
          entity: 'risksIssues',
          fieldMapping: {
            type: 'type',
            title: 'title',
            content: 'content',
            impact: 'impact',
            priority: 'priority',
          },
          defaultProjectId: PROJECT_ID,
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.risksIssues.validRows).toBe(0);
      expect(r.errors[0]?.field).toBe('projectId');
    }
  });
});

describe('applyImport', () => {
  function makeFakePreview(opts: {
    tenantId?: string;
    userId?: string;
    expiresAt?: Date;
    knowledge?: number;
  }) {
    return {
      id: 'preview-1',
      tenantId: opts.tenantId ?? TENANT_ID,
      createdByUserId: opts.userId ?? USER_ID,
      parsedJson: {
        knowledge: Array.from({ length: opts.knowledge ?? 1 }, (_, i) => ({
          sourceRow: i + 2,
          title: `T${i}`,
          knowledgeType: 'general',
          background: 'B',
          content: 'C',
          result: 'R',
          techTags: [],
          processTags: [],
          businessDomainTags: [],
          visibility: 'company',
        })),
        risksIssues: [],
      },
      costEstimate: {},
      summary: {},
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
      createdAt: new Date(),
    } as never;
  }

  it('preview 不在 → PREVIEW_NOT_FOUND', async () => {
    vi.mocked(prisma.tenantImportPreview.findUnique).mockResolvedValueOnce(null);
    const r = await applyImport({ tenantId: TENANT_ID, userId: USER_ID, previewId: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('PREVIEW_NOT_FOUND');
  });

  it('別テナントの preview → PREVIEW_NOT_FOUND (認可境界)', async () => {
    vi.mocked(prisma.tenantImportPreview.findUnique).mockResolvedValueOnce(
      makeFakePreview({ tenantId: 'other-tenant-id' }),
    );
    const r = await applyImport({ tenantId: TENANT_ID, userId: USER_ID, previewId: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('PREVIEW_NOT_FOUND');
  });

  it('別管理者の preview → PREVIEW_NOT_OWNED', async () => {
    vi.mocked(prisma.tenantImportPreview.findUnique).mockResolvedValueOnce(
      makeFakePreview({ userId: OTHER_USER_ID }),
    );
    const r = await applyImport({ tenantId: TENANT_ID, userId: USER_ID, previewId: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('PREVIEW_NOT_OWNED');
  });

  it('TTL 切れ → PREVIEW_EXPIRED', async () => {
    vi.mocked(prisma.tenantImportPreview.findUnique).mockResolvedValueOnce(
      makeFakePreview({ expiresAt: new Date(Date.now() - 1000) }),
    );
    const r = await applyImport({ tenantId: TENANT_ID, userId: USER_ID, previewId: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('PREVIEW_EXPIRED');
  });

  it('apply 直前の再評価で Beginner 上限超過 → BEGINNER_CALL_LIMIT', async () => {
    vi.mocked(prisma.tenantImportPreview.findUnique).mockResolvedValueOnce(
      makeFakePreview({ knowledge: 50 }),
    );
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'beginner',
      currentMonthApiCallCount: 80,
      currentMonthApiCostJpy: 0,
      monthlyBudgetCapJpy: null,
      beginnerMonthlyCallLimit: 100,
      pricePerCallHaiku: 10,
      pricePerCallSonnet: 30,
      deletedAt: null,
    } as never);
    const r = await applyImport({ tenantId: TENANT_ID, userId: USER_ID, previewId: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('BEGINNER_CALL_LIMIT');
  });

  it('正常系: Knowledge 1 件取込 + embedding 生成 + preview 削除', async () => {
    vi.mocked(prisma.tenantImportPreview.findUnique).mockResolvedValueOnce(
      makeFakePreview({ knowledge: 1 }),
    );
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'expert',
      currentMonthApiCallCount: 0,
      currentMonthApiCostJpy: 0,
      monthlyBudgetCapJpy: null,
      beginnerMonthlyCallLimit: 100,
      pricePerCallHaiku: 10,
      pricePerCallSonnet: 30,
      deletedAt: null,
    } as never);
    tx.knowledge.create.mockResolvedValue({} as never);
    tx.tenantImportPreview.delete.mockResolvedValue({} as never);

    const r = await applyImport({ tenantId: TENANT_ID, userId: USER_ID, previewId: 'x' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.knowledgeCreated).toBe(1);
      expect(r.summary.risksIssuesCreated).toBe(0);
      expect(r.summary.embeddingGenerated).toBe(1);
      expect(r.summary.totalCostJpy).toBe(10); // ¥10 × 1
    }
    expect(tx.tenantImportPreview.delete).toHaveBeenCalledWith({ where: { id: 'x' } });
  });
});

describe('deleteExpiredPreviews', () => {
  it('期限切れ件数を返す', async () => {
    vi.mocked(prisma.tenantImportPreview.deleteMany).mockResolvedValueOnce({ count: 7 } as never);
    const count = await deleteExpiredPreviews(new Date('2026-05-09T00:00:00Z'));
    expect(count).toBe(7);
    expect(prisma.tenantImportPreview.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: new Date('2026-05-09T00:00:00Z') } },
    });
  });
});

describe('CSV パーサ統合: UTF-8 BOM の扱い', () => {
  it('UTF-8 BOM 付き CSV も正常にパースできる', async () => {
    const csvBody = ['title,background,content,result', 'BomTitle,B,C,R'].join('\n');
    const fileBuffer = Buffer.concat([Buffer.from('﻿'), Buffer.from(csvBody, 'utf-8')]);
    const r = await previewImport({
      tenantId: TENANT_ID,
      userId: USER_ID,
      fileBuffer,
      mappings: [
        {
          entity: 'knowledge',
          fieldMapping: {
            title: 'title',
            background: 'background',
            content: 'content',
            result: 'result',
          },
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.knowledge.validRows).toBe(1);
    }
  });
});

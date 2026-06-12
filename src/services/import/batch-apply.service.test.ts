import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    riskIssue: { create: vi.fn() },
    riskIssueProject: { create: vi.fn() },
    knowledge: { create: vi.fn() },
    knowledgeProject: { create: vi.fn() },
    retrospective: { create: vi.fn() },
    retrospectiveProject: { create: vi.fn() },
  },
}));
vi.mock('@/services/customer.service', () => ({ createCustomer: vi.fn() }));
vi.mock('@/services/project.service', () => ({ createProject: vi.fn() }));
vi.mock('@/services/task-sync-import.service', () => ({ applySyncImport: vi.fn() }));
vi.mock('@/services/risk.service', () => ({ computePriority: vi.fn() }));
vi.mock('@/services/import/wbs-sync-rows', () => ({ toSyncImportRows: vi.fn().mockReturnValue([]) }));

import { applyImportBatch } from './batch-apply.service';
import { prisma } from '@/lib/db';
import { createCustomer } from '@/services/customer.service';
import { createProject } from '@/services/project.service';
import { applySyncImport } from '@/services/task-sync-import.service';
import { computePriority } from '@/services/risk.service';
import type { ResolvedBatch, ResolvedRiskIssue, ResolvedKnowledge, ResolvedRetrospective } from './batch-preview';

const emptyBatch: ResolvedBatch = {
  customers: [],
  projects: [],
  externalWbs: [],
  externalRisks: [],
  externalKnowledge: [],
  externalRetros: [],
};

const baseRisk: ResolvedRiskIssue = {
  type: 'risk',
  title: 'リスクA',
  occurrence: null,
  content: '内容',
  cause: null,
  impact: 'medium',
  likelihood: 'low',
  responsePolicy: null,
  deadline: null,
  riskNature: 'threat',
  visibility: 'draft',
};

const baseKnowledge: ResolvedKnowledge = {
  title: 'ナレッジA',
  knowledgeType: 'other',
  background: '背景',
  content: '内容',
  result: '結果',
  visibility: 'draft',
};

const baseRetro: ResolvedRetrospective = {
  conductedDate: '2026-01-01',
  planSummary: '計画',
  actualSummary: '実績',
  goodPoints: '良かった点',
  problems: '問題',
  improvements: '改善',
  visibility: 'draft',
};

beforeEach(() => vi.clearAllMocks());

describe('applyImportBatch', () => {
  it('空バッチはすべて 0 件・エラーなし', async () => {
    const r = await applyImportBatch({ tenantId: 't1', userId: 'u1', resolved: emptyBatch });
    expect(r).toEqual({
      customersCreated: 0,
      projectsCreated: 0,
      wbsCreated: 0,
      risksCreated: 0,
      knowledgeCreated: 0,
      retrospectivesCreated: 0,
      errors: [],
    });
  });

  it('顧客を作成して customerIdByKey に登録する', async () => {
    vi.mocked(createCustomer).mockResolvedValue({ id: 'cst1' } as never);
    const r = await applyImportBatch({
      tenantId: 't1',
      userId: 'u1',
      resolved: {
        ...emptyBatch,
        customers: [{ sourceKey: 'k1', name: '顧客A', department: null, contactPerson: null, contactEmail: null, notes: null }],
      },
    });
    expect(r.customersCreated).toBe(1);
    expect(createCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ name: '顧客A' }),
      'u1',
      't1',
    );
  });

  it('バッチ内 customerKey でプロジェクトを作成する', async () => {
    vi.mocked(createCustomer).mockResolvedValue({ id: 'cst1' } as never);
    vi.mocked(createProject).mockResolvedValue({ id: 'prj1' } as never);
    vi.mocked(applySyncImport).mockResolvedValue({ added: 0 } as never);
    const r = await applyImportBatch({
      tenantId: 't1',
      userId: 'u1',
      resolved: {
        ...emptyBatch,
        customers: [{ sourceKey: 'k1', name: '顧客A', department: null, contactPerson: null, contactEmail: null, notes: null }],
        projects: [{
          sourceKey: 'p1', customerKey: 'k1', existingCustomerId: null,
          name: 'プロジェクトA', purpose: '', background: '', scope: '', devMethod: 'scratch',
          contractType: null, status: 'planning', plannedStartDate: '2026-01-01', plannedEndDate: '2026-03-31',
          wbs: [], risks: [], knowledge: [], retros: [],
        }],
      },
    });
    expect(r.projectsCreated).toBe(1);
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cst1', name: 'プロジェクトA' }),
      'u1',
      't1',
    );
    expect(r.errors).toHaveLength(0);
  });

  it('existingCustomerId でプロジェクトを作成する (customerKey なし)', async () => {
    vi.mocked(createProject).mockResolvedValue({ id: 'prj1' } as never);
    vi.mocked(applySyncImport).mockResolvedValue({ added: 0 } as never);
    const r = await applyImportBatch({
      tenantId: 't1',
      userId: 'u1',
      resolved: {
        ...emptyBatch,
        projects: [{
          sourceKey: 'p1', customerKey: null, existingCustomerId: 'cst-existing',
          name: 'プロジェクトB', purpose: '', background: '', scope: '', devMethod: 'package',
          contractType: null, status: 'planning', plannedStartDate: '2026-01-01', plannedEndDate: '2026-06-30',
          wbs: [], risks: [], knowledge: [], retros: [],
        }],
      },
    });
    expect(r.projectsCreated).toBe(1);
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cst-existing' }),
      'u1',
      't1',
    );
  });

  it('customerKey が解決できない場合はエラーを積んでスキップ', async () => {
    const r = await applyImportBatch({
      tenantId: 't1',
      userId: 'u1',
      resolved: {
        ...emptyBatch,
        projects: [{
          sourceKey: 'p1', customerKey: 'nonexistent', existingCustomerId: null,
          name: 'プロジェクトC', purpose: '', background: '', scope: '', devMethod: 'scratch',
          contractType: null, status: 'planning', plannedStartDate: '2026-01-01', plannedEndDate: '2026-03-31',
          wbs: [], risks: [], knowledge: [], retros: [],
        }],
      },
    });
    expect(r.projectsCreated).toBe(0);
    expect(createProject).not.toHaveBeenCalled();
    expect(r.errors).toEqual([{ entity: 'project', ref: 'p1', reason: '顧客が解決できませんでした' }]);
  });

  it('plannedStartDate が null の場合はエラーを積んでスキップ', async () => {
    vi.mocked(createCustomer).mockResolvedValue({ id: 'cst1' } as never);
    const r = await applyImportBatch({
      tenantId: 't1',
      userId: 'u1',
      resolved: {
        ...emptyBatch,
        customers: [{ sourceKey: 'k1', name: '顧客A', department: null, contactPerson: null, contactEmail: null, notes: null }],
        projects: [{
          sourceKey: 'p1', customerKey: 'k1', existingCustomerId: null,
          name: 'プロジェクトD', purpose: '', background: '', scope: '', devMethod: 'scratch',
          contractType: null, status: 'planning', plannedStartDate: null, plannedEndDate: '2026-03-31',
          wbs: [], risks: [], knowledge: [], retros: [],
        }],
      },
    });
    expect(r.errors).toEqual([{ entity: 'project', ref: 'p1', reason: '必須の予定日が未設定です' }]);
    expect(createProject).not.toHaveBeenCalled();
  });

  it('plannedEndDate が null の場合はエラーを積んでスキップ', async () => {
    vi.mocked(createCustomer).mockResolvedValue({ id: 'cst1' } as never);
    const r = await applyImportBatch({
      tenantId: 't1',
      userId: 'u1',
      resolved: {
        ...emptyBatch,
        customers: [{ sourceKey: 'k1', name: '顧客A', department: null, contactPerson: null, contactEmail: null, notes: null }],
        projects: [{
          sourceKey: 'p1', customerKey: 'k1', existingCustomerId: null,
          name: 'プロジェクトE', purpose: '', background: '', scope: '', devMethod: 'scratch',
          contractType: null, status: 'planning', plannedStartDate: '2026-01-01', plannedEndDate: null,
          wbs: [], risks: [], knowledge: [], retros: [],
        }],
      },
    });
    expect(r.errors).toEqual([{ entity: 'project', ref: 'p1', reason: '必須の予定日が未設定です' }]);
  });

  it('プロジェクト配下の子資産 (risk/knowledge/retro) を作成する', async () => {
    vi.mocked(createCustomer).mockResolvedValue({ id: 'cst1' } as never);
    vi.mocked(createProject).mockResolvedValue({ id: 'prj1' } as never);
    vi.mocked(computePriority).mockReturnValue('high' as never);
    vi.mocked(prisma.riskIssue.create).mockResolvedValue({ id: 'ri1' } as never);
    vi.mocked(prisma.riskIssueProject.create).mockResolvedValue({} as never);
    vi.mocked(prisma.knowledge.create).mockResolvedValue({ id: 'kn1' } as never);
    vi.mocked(prisma.knowledgeProject.create).mockResolvedValue({} as never);
    vi.mocked(prisma.retrospective.create).mockResolvedValue({ id: 'rt1' } as never);
    vi.mocked(prisma.retrospectiveProject.create).mockResolvedValue({} as never);
    vi.mocked(applySyncImport).mockResolvedValue({ added: 0 } as never);

    const r = await applyImportBatch({
      tenantId: 't1',
      userId: 'u1',
      resolved: {
        ...emptyBatch,
        customers: [{ sourceKey: 'k1', name: '顧客A', department: null, contactPerson: null, contactEmail: null, notes: null }],
        projects: [{
          sourceKey: 'p1', customerKey: 'k1', existingCustomerId: null,
          name: 'プロジェクトF', purpose: '', background: '', scope: '', devMethod: 'scratch',
          contractType: null, status: 'planning', plannedStartDate: '2026-01-01', plannedEndDate: '2026-03-31',
          wbs: [],
          risks: [baseRisk],
          knowledge: [baseKnowledge],
          retros: [baseRetro],
        }],
      },
    });

    expect(r.risksCreated).toBe(1);
    expect(r.knowledgeCreated).toBe(1);
    expect(r.retrospectivesCreated).toBe(1);
    expect(prisma.riskIssueProject.create).toHaveBeenCalledWith({ data: { riskIssueId: 'ri1', projectId: 'prj1' } });
    expect(prisma.knowledgeProject.create).toHaveBeenCalledWith({ data: { knowledgeId: 'kn1', projectId: 'prj1' } });
    expect(prisma.retrospectiveProject.create).toHaveBeenCalledWith({ data: { retrospectiveId: 'rt1', projectId: 'prj1' } });
  });

  it('externalWbs: rows が空はスキップする', async () => {
    const r = await applyImportBatch({
      tenantId: 't1',
      userId: 'u1',
      resolved: {
        ...emptyBatch,
        externalWbs: [{ projectId: 'prj1', projectName: 'PJ', rows: [] }],
      },
    });
    expect(applySyncImport).not.toHaveBeenCalled();
    expect(r.wbsCreated).toBe(0);
    expect(r.errors).toHaveLength(0);
  });

  it('externalWbs: applySyncImport が追加件数を返す', async () => {
    vi.mocked(applySyncImport).mockResolvedValue({ added: 3 } as never);
    const r = await applyImportBatch({
      tenantId: 't1',
      userId: 'u1',
      resolved: {
        ...emptyBatch,
        externalWbs: [{ projectId: 'prj1', projectName: 'PJ', rows: [{ id: 'w1' } as never] }],
      },
    });
    expect(r.wbsCreated).toBe(3);
    expect(r.errors).toHaveLength(0);
  });

  it('externalWbs: applySyncImport が例外をスローしたらエラーを積む', async () => {
    vi.mocked(applySyncImport).mockRejectedValue(new Error('DB error'));
    const r = await applyImportBatch({
      tenantId: 't1',
      userId: 'u1',
      resolved: {
        ...emptyBatch,
        externalWbs: [{ projectId: 'prj1', projectName: 'プロジェクトX', rows: [{ id: 'w1' } as never] }],
      },
    });
    expect(r.errors).toEqual([{ entity: 'wbs', ref: 'プロジェクトX', reason: 'DB error' }]);
    expect(r.wbsCreated).toBe(0);
  });

  it('externalRisks: projectId=null は M:N 結合を作らない', async () => {
    vi.mocked(computePriority).mockReturnValue('low' as never);
    vi.mocked(prisma.riskIssue.create).mockResolvedValue({ id: 'ri1' } as never);
    const r = await applyImportBatch({
      tenantId: 't1',
      userId: 'u1',
      resolved: { ...emptyBatch, externalRisks: [{ projectId: null, data: baseRisk }] },
    });
    expect(r.risksCreated).toBe(1);
    expect(prisma.riskIssueProject.create).not.toHaveBeenCalled();
  });

  it('externalRisks: projectId あり → M:N 結合を作成する', async () => {
    vi.mocked(computePriority).mockReturnValue('medium' as never);
    vi.mocked(prisma.riskIssue.create).mockResolvedValue({ id: 'ri1' } as never);
    vi.mocked(prisma.riskIssueProject.create).mockResolvedValue({} as never);
    await applyImportBatch({
      tenantId: 't1',
      userId: 'u1',
      resolved: { ...emptyBatch, externalRisks: [{ projectId: 'prj1', data: baseRisk }] },
    });
    expect(prisma.riskIssueProject.create).toHaveBeenCalledWith({ data: { riskIssueId: 'ri1', projectId: 'prj1' } });
  });

  it('externalKnowledge: projectId=null は M:N 結合を作らない', async () => {
    vi.mocked(prisma.knowledge.create).mockResolvedValue({ id: 'kn1' } as never);
    const r = await applyImportBatch({
      tenantId: 't1',
      userId: 'u1',
      resolved: { ...emptyBatch, externalKnowledge: [{ projectId: null, data: baseKnowledge }] },
    });
    expect(r.knowledgeCreated).toBe(1);
    expect(prisma.knowledgeProject.create).not.toHaveBeenCalled();
  });

  it('externalRetros: conductedDate=null は当日日付で補完する', async () => {
    vi.mocked(prisma.retrospective.create).mockResolvedValue({ id: 'rt1' } as never);
    await applyImportBatch({
      tenantId: 't1',
      userId: 'u1',
      resolved: {
        ...emptyBatch,
        externalRetros: [{ projectId: null, data: { ...baseRetro, conductedDate: null } }],
      },
    });
    const callArg = vi.mocked(prisma.retrospective.create).mock.calls[0][0];
    expect(callArg.data.conductedDate).toBeInstanceOf(Date);
  });

  it('複数エラーが蓄積され他の処理は継続される', async () => {
    const r = await applyImportBatch({
      tenantId: 't1',
      userId: 'u1',
      resolved: {
        ...emptyBatch,
        projects: [
          {
            sourceKey: 'p1', customerKey: 'missing', existingCustomerId: null,
            name: 'PJ1', purpose: '', background: '', scope: '', devMethod: 'scratch',
            contractType: null, status: 'planning', plannedStartDate: '2026-01-01', plannedEndDate: '2026-03-31',
            wbs: [], risks: [], knowledge: [], retros: [],
          },
          {
            sourceKey: 'p2', customerKey: null, existingCustomerId: null,
            name: 'PJ2', purpose: '', background: '', scope: '', devMethod: 'scratch',
            contractType: null, status: 'planning', plannedStartDate: null, plannedEndDate: null,
            wbs: [], risks: [], knowledge: [], retros: [],
          },
        ],
      },
    });
    expect(r.errors).toHaveLength(2);
    expect(r.projectsCreated).toBe(0);
  });
});

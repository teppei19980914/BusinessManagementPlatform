/**
 * 外部移行インポート — apply (DB 書き込み) (ADR-0034)
 *
 * ResolvedBatch (batch-preview の出力) を依存順に DB へ取り込む。
 *   顧客 → プロジェクト → WBS / 各資産。新規作成のみ (重複制御なし)。
 *
 * 流用:
 *   - 顧客/プロジェクト作成: createCustomer / createProject (選択値は preview で内部値化済)
 *   - WBS: applySyncImport の CREATE パス (ADR-0032 で createMany バッチ化済)
 *   - リスク優先度: risk.service の computePriority (自動算出)
 *   - 各資産はプロジェクトとの M:N 結合も作成し、一覧 (riskIssueProjects 等) に表示されるようにする
 *
 * 注意:
 *   - 担当者はブランク (ADR-0034)。reporter/creator は実行管理者。
 *   - embedding は本 apply では生成しない。取り込み既定は visibility='draft' で embedding 対象外
 *     (feedback_visibility_embedding)。public 資産の embedding はコスト見積り経路の後続課題。
 *   - DB 直結のため最終確認はローカル環境で行う。
 */

import { prisma } from '@/lib/db';
import { createCustomer } from '../customer.service';
import { createProject } from '../project.service';
import { applySyncImport } from '../task-sync-import.service';
import { computePriority } from '../risk.service';
import { toSyncImportRows } from './wbs-sync-rows';
import type {
  ResolvedBatch,
  ResolvedProject,
  ResolvedRiskIssue,
  ResolvedKnowledge,
  ResolvedRetrospective,
} from './batch-preview';

export interface ApplyImportResult {
  customersCreated: number;
  projectsCreated: number;
  wbsCreated: number;
  risksCreated: number;
  knowledgeCreated: number;
  retrospectivesCreated: number;
  errors: { entity: string; ref: string; reason: string }[];
}

/** 'YYYY-MM-DD' (Retrospective conductedDate の当日補完用) */
function todayDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export async function applyImportBatch(params: {
  tenantId: string;
  userId: string;
  resolved: ResolvedBatch;
}): Promise<ApplyImportResult> {
  const { tenantId, userId, resolved } = params;
  const result: ApplyImportResult = {
    customersCreated: 0,
    projectsCreated: 0,
    wbsCreated: 0,
    risksCreated: 0,
    knowledgeCreated: 0,
    retrospectivesCreated: 0,
    errors: [],
  };

  // ---- 顧客 (親) ----
  const customerIdByKey = new Map<string, string>();
  for (const c of resolved.customers) {
    const dto = await createCustomer(
      {
        name: c.name,
        department: c.department ?? undefined,
        contactPerson: c.contactPerson ?? undefined,
        contactEmail: c.contactEmail ?? undefined,
        notes: c.notes ?? undefined,
      },
      userId,
      tenantId,
    );
    customerIdByKey.set(c.sourceKey, dto.id);
    result.customersCreated += 1;
  }

  // ---- プロジェクト + 配下 ----
  for (const p of resolved.projects) {
    // 同バッチの新規顧客 → 既存顧客 の順に解決
    const customerId = p.customerKey
      ? customerIdByKey.get(p.customerKey)
      : (p.existingCustomerId ?? undefined);
    if (!customerId) {
      result.errors.push({ entity: 'project', ref: p.sourceKey, reason: '顧客が解決できませんでした' });
      continue;
    }
    if (!p.plannedStartDate || !p.plannedEndDate) {
      result.errors.push({ entity: 'project', ref: p.sourceKey, reason: '必須の予定日が未設定です' });
      continue;
    }

    const project = await createProject(
      {
        name: p.name,
        customerId,
        purpose: p.purpose,
        background: p.background,
        scope: p.scope,
        devMethod: p.devMethod,
        contractType: p.contractType ?? null,
        status: p.status,
        plannedStartDate: p.plannedStartDate,
        plannedEndDate: p.plannedEndDate,
      },
      userId,
      tenantId,
    );
    result.projectsCreated += 1;

    await applyProjectChildren(tenantId, userId, project.id, p, result);
  }

  // ---- バッチ外 WBS (既存プロジェクト配下に追加。既存タスクは保持) ----
  //   applySyncImport の removeMode='keep' は「CSV に無い既存タスクを消さない」純追加。
  //   computeSyncDiff 内で project.tenantId を検証するため越境はしない。
  for (const g of resolved.externalWbs) {
    if (g.rows.length === 0) continue;
    try {
      const rows = toSyncImportRows(g.rows);
      const r = await applySyncImport(g.projectId, rows, 'keep', userId, tenantId);
      result.wbsCreated += r.added;
    } catch (e) {
      result.errors.push({
        entity: 'wbs',
        ref: g.projectName,
        reason: e instanceof Error ? e.message : 'WBS の取り込みに失敗しました',
      });
    }
  }

  // ---- バッチ外の資産 (standalone or 既存プロジェクト紐づけ) ----
  for (const a of resolved.externalRisks ?? []) {
    await createRiskIssue(tenantId, userId, a.projectId, a.data);
    result.risksCreated += 1;
  }
  for (const a of resolved.externalKnowledge ?? []) {
    await createKnowledgeEntry(tenantId, userId, a.projectId, a.data);
    result.knowledgeCreated += 1;
  }
  for (const a of resolved.externalRetros ?? []) {
    await createRetrospectiveEntry(tenantId, userId, a.projectId, a.data);
    result.retrospectivesCreated += 1;
  }

  return result;
}

/** リスク・課題を作成する。projectId が null なら standalone (M:N 結合なし)。 */
async function createRiskIssue(
  tenantId: string,
  userId: string,
  projectId: string | null,
  r: ResolvedRiskIssue,
): Promise<void> {
  const created = await prisma.riskIssue.create({
    data: {
      tenantId,
      projectId,
      type: r.type,
      title: r.title,
      occurrence: r.occurrence,
      content: r.content,
      cause: r.cause,
      impact: r.impact,
      likelihood: r.likelihood,
      priority: computePriority(r.type, r.impact, r.likelihood ?? 'low'),
      responsePolicy: r.responsePolicy,
      reporterId: userId,
      assigneeId: null,
      deadline: r.deadline ? new Date(r.deadline) : null,
      state: 'open',
      visibility: r.visibility,
      riskNature: r.type === 'risk' ? (r.riskNature ?? 'threat') : null,
      createdBy: userId,
      updatedBy: userId,
    },
    select: { id: true },
  });
  if (projectId) {
    await prisma.riskIssueProject.create({ data: { riskIssueId: created.id, projectId } });
  }
}

/** ナレッジを作成する (テナント直下)。projectId があれば M:N 結合で当該プロジェクトに表示。 */
async function createKnowledgeEntry(
  tenantId: string,
  userId: string,
  projectId: string | null,
  k: ResolvedKnowledge,
): Promise<void> {
  const created = await prisma.knowledge.create({
    data: {
      tenantId,
      title: k.title,
      knowledgeType: k.knowledgeType,
      background: k.background,
      content: k.content,
      result: k.result,
      visibility: k.visibility,
      createdBy: userId,
      updatedBy: userId,
    },
    select: { id: true },
  });
  if (projectId) {
    await prisma.knowledgeProject.create({ data: { knowledgeId: created.id, projectId } });
  }
}

/** 振り返りを作成する。projectId が null なら standalone (M:N 結合なし)。 */
async function createRetrospectiveEntry(
  tenantId: string,
  userId: string,
  projectId: string | null,
  rt: ResolvedRetrospective,
): Promise<void> {
  const created = await prisma.retrospective.create({
    data: {
      tenantId,
      projectId,
      conductedDate: new Date(rt.conductedDate ?? todayDateString()),
      planSummary: rt.planSummary,
      actualSummary: rt.actualSummary,
      goodPoints: rt.goodPoints,
      problems: rt.problems,
      improvements: rt.improvements,
      visibility: rt.visibility,
      createdBy: userId,
      updatedBy: userId,
    },
    select: { id: true },
  });
  if (projectId) {
    await prisma.retrospectiveProject.create({ data: { retrospectiveId: created.id, projectId } });
  }
}

async function applyProjectChildren(
  tenantId: string,
  userId: string,
  projectId: string,
  p: ResolvedProject,
  result: ApplyImportResult,
): Promise<void> {
  // ---- WBS (applySyncImport の CREATE パス流用) ----
  if (p.wbs.length > 0) {
    const rows = toSyncImportRows(p.wbs);
    const r = await applySyncImport(projectId, rows, 'keep', userId, tenantId);
    result.wbsCreated += r.added;
  }

  // ---- リスク・課題 / ナレッジ / 振り返り (projectId 直 + M:N 結合) ----
  for (const r of p.risks) {
    await createRiskIssue(tenantId, userId, projectId, r);
    result.risksCreated += 1;
  }
  for (const k of p.knowledge) {
    await createKnowledgeEntry(tenantId, userId, projectId, k);
    result.knowledgeCreated += 1;
  }
  for (const rt of p.retros) {
    await createRetrospectiveEntry(tenantId, userId, projectId, rt);
    result.retrospectivesCreated += 1;
  }
}

/**
 * Sample (starter) data clone service (feat/starter-data-import / 2026-06-05)
 *
 * 目的:
 *   テナント管理者が「スターターデータ」を 1 クリックで自テナントに取り込み、
 *   空の状態でも提案機能・チャット検索・各画面を体験できるようにする。
 *
 * 設計 (選択肢A: 管理テナントからのクローン):
 *   - **複製元**: システム管理テナント (MANAGEMENT_TENANT_ID) に db:seed で投入された
 *     `isSampleData=true` のサンプル (顧客 / プロジェクト / 子の課題・リスク / 振り返り / ナレッジ)。
 *     ※ 厳格に `isSampleData=true` のみを読むため、運営の実データ (isSampleData=false) は混入しない。
 *   - **複製先**: 実行者のテナント。複製行は `isSampleData=false` (= 一覧に通常表示) かつ
 *     `isSeedSample=true` (= 後の一括削除で対象特定するマーカー) で投入する。
 *   - **埋め込み**: 複製元の content_embedding を raw SQL でそのままコピーする (= Voyage 再呼出なし、
 *     課金ゼロ)。seedTenant() と同じ手法。
 *   - **可視化**: 課題/リスク・振り返りは一覧が M:N 中間テーブル経由のため、複製時に
 *     RiskIssueProject / RetrospectiveProject の連結も作成する (seed 本体は未作成 = 管理テナントでは
 *     一覧非表示で正しい。複製先では「見える」ことが目的なので連結を張る)。
 *
 * ガード:
 *   - DB 容量事前判定 (precheckImportStorage): Beginner は 50MB 無料枠超過でブロック、
 *     Expert/Pro は警告のみで継続 (青天井従量課金) — UI 側で確認ダイアログ → 承認後に呼ばれる。
 *   - 認可 (admin 限定) / read-only 判定は API route 側で共通ガードに委譲する。
 *
 * 削除:
 *   - 自テナントの `isSeedSample=true` のみを依存順に**物理削除**する (= 使い捨てサンプルのため、
 *     論理削除では Customer の NOT NULL customer_id FK と整合が取れず、容量も解放されないため)。
 *
 * 関連:
 *   - クローン元生成: prisma/seed-suggestion.ts (seedTenant / insertSeedSample*)
 *   - マーカー列: prisma/migrations/20260612_add_is_seed_sample_marker
 *   - API: src/app/api/tenants/me/sample-data/route.ts
 */

import { prisma } from '@/lib/db';
import { MANAGEMENT_TENANT_ID } from '@/lib/tenant';
import { recordAuditLog } from '@/services/audit.service';
import {
  AVG_BYTES_PER_IMPORTED_ROW,
  precheckImportStorage,
  type PlanCode,
} from '@/services/import-storage-precheck.service';
import type { Prisma } from '@/generated/prisma/client';

export type SampleCloneSummary = {
  customers: number;
  projects: number;
  knowledge: number;
  risksIssues: number;
  retrospectives: number;
};

export type ImportSampleDataResult =
  | { ok: true; summary: SampleCloneSummary }
  | {
      ok: false;
      error: 'NO_SAMPLE_DATA' | 'STORAGE_BLOCKED';
      message: string;
    };

export type DeleteSampleDataResult = {
  ok: true;
  summary: SampleCloneSummary;
};

const EMPTY_SUMMARY: SampleCloneSummary = {
  customers: 0,
  projects: 0,
  knowledge: 0,
  risksIssues: 0,
  retrospectives: 0,
};

/**
 * 管理テナントのスターターデータを実行者テナントへクローンする。
 *
 * @param tenantId 取込先 (= 実行者) テナント
 * @param userId   実行者ユーザ (createdBy / updatedBy / reporterId に使用)
 * @param plan     取込先テナントのプラン (容量判定に使用)
 */
export async function importSampleData(args: {
  tenantId: string;
  userId: string;
  plan: PlanCode;
}): Promise<ImportSampleDataResult> {
  const { tenantId, userId, plan } = args;

  // ---------- 1. 複製元の読み出し (管理テナント / isSampleData=true 厳格フィルタ) ----------
  const sourceProjects = await prisma.project.findMany({
    where: { tenantId: MANAGEMENT_TENANT_ID, isSampleData: true, deletedAt: null },
    include: { customer: true },
  });
  const sourceProjectIds = sourceProjects.map((p) => p.id);

  const [sourceKnowledge, sourceRisks, sourceRetros] = await Promise.all([
    prisma.knowledge.findMany({
      where: { tenantId: MANAGEMENT_TENANT_ID, isSampleData: true, deletedAt: null },
    }),
    sourceProjectIds.length
      ? prisma.riskIssue.findMany({
          where: { tenantId: MANAGEMENT_TENANT_ID, projectId: { in: sourceProjectIds }, deletedAt: null },
        })
      : Promise.resolve([]),
    sourceProjectIds.length
      ? prisma.retrospective.findMany({
          where: { tenantId: MANAGEMENT_TENANT_ID, projectId: { in: sourceProjectIds }, deletedAt: null },
        })
      : Promise.resolve([]),
  ]);

  if (
    sourceProjects.length === 0 &&
    sourceKnowledge.length === 0 &&
    sourceRisks.length === 0 &&
    sourceRetros.length === 0
  ) {
    return {
      ok: false,
      error: 'NO_SAMPLE_DATA',
      message:
        'システム管理テナントにスターターデータが見つかりませんでした。運営にお問い合わせください。',
    };
  }

  // ---------- 2. DB 容量事前判定 ----------
  //   projects は embedding を持つため knowledge 相当 (~7KB)、customers は task 相当 (~1KB) で概算。
  const estimatedAddedBytes =
    sourceKnowledge.length * AVG_BYTES_PER_IMPORTED_ROW.knowledge +
    sourceRisks.length * AVG_BYTES_PER_IMPORTED_ROW.risksIssues +
    sourceRetros.length * AVG_BYTES_PER_IMPORTED_ROW.retrospective +
    sourceProjects.length * AVG_BYTES_PER_IMPORTED_ROW.knowledge +
    sourceProjects.length * AVG_BYTES_PER_IMPORTED_ROW.task;
  const storage = await precheckImportStorage({ tenantId, plan, estimatedAddedBytes });
  if (storage.isBlocker) {
    return { ok: false, error: 'STORAGE_BLOCKED', message: storage.message };
  }

  // ---------- 3. トランザクション投入 ----------
  const summary = await prisma.$transaction(async (tx) => {
    const s: SampleCloneSummary = { ...EMPTY_SUMMARY };

    // embedding コピー対象 (table, srcId, newId) を貯めて最後に raw SQL でまとめてコピーする
    const embeddingCopies: Array<{ table: string; srcId: string; newId: string }> = [];

    // 3-1. 顧客 (1 回の取込内では source 顧客 id ごとに 1 回だけ作成)
    const customerIdMap = new Map<string, string>();
    for (const p of sourceProjects) {
      if (customerIdMap.has(p.customerId)) continue;
      const created = await tx.customer.create({
        data: {
          tenantId,
          name: p.customer.name,
          department: p.customer.department,
          contactPerson: p.customer.contactPerson,
          contactEmail: p.customer.contactEmail,
          notes: p.customer.notes,
          isSeedSample: true,
          createdBy: userId,
          updatedBy: userId,
        },
        select: { id: true },
      });
      customerIdMap.set(p.customerId, created.id);
      s.customers += 1;
    }

    // 3-2. プロジェクト (isSampleData=false で一覧表示、isSeedSample=true で削除対象マーク)
    const projectIdMap = new Map<string, string>();
    for (const p of sourceProjects) {
      const created = await tx.project.create({
        data: {
          tenantId,
          name: p.name,
          customerId: customerIdMap.get(p.customerId)!,
          purpose: p.purpose,
          background: p.background,
          scope: p.scope,
          outOfScope: p.outOfScope,
          devMethod: p.devMethod,
          contractType: p.contractType,
          businessDomainTags: p.businessDomainTags as Prisma.InputJsonValue,
          techStackTags: p.techStackTags as Prisma.InputJsonValue,
          processTags: p.processTags as Prisma.InputJsonValue,
          plannedStartDate: p.plannedStartDate,
          plannedEndDate: p.plannedEndDate,
          actualStartDate: p.actualStartDate,
          actualEndDate: p.actualEndDate,
          status: p.status,
          notes: p.notes,
          isSampleData: false,
          isSeedSample: true,
          createdBy: userId,
          updatedBy: userId,
        },
        select: { id: true },
      });
      projectIdMap.set(p.id, created.id);
      embeddingCopies.push({ table: 'projects', srcId: p.id, newId: created.id });
      s.projects += 1;
    }

    // 3-3. ナレッジ (テナント級。visibility=public のまま、一覧表示)
    for (const k of sourceKnowledge) {
      const created = await tx.knowledge.create({
        data: {
          tenantId,
          title: k.title,
          knowledgeType: k.knowledgeType,
          background: k.background,
          content: k.content,
          result: k.result,
          conclusion: k.conclusion,
          recommendation: k.recommendation,
          reusability: k.reusability,
          techTags: k.techTags as Prisma.InputJsonValue,
          devMethod: k.devMethod,
          processTags: k.processTags as Prisma.InputJsonValue,
          businessDomainTags: k.businessDomainTags as Prisma.InputJsonValue,
          visibility: k.visibility,
          isSampleData: false,
          isSeedSample: true,
          createdBy: userId,
          updatedBy: userId,
        },
        select: { id: true },
      });
      embeddingCopies.push({ table: 'knowledges', srcId: k.id, newId: created.id });
      s.knowledge += 1;
    }

    // 3-4. 課題 / リスク (親プロジェクトが複製対象のもののみ。M:N 連結も作成し一覧表示可能にする)
    for (const r of sourceRisks) {
      const newProjectId = r.projectId ? projectIdMap.get(r.projectId) : undefined;
      if (!newProjectId) continue; // 親が複製対象外なら skip (通常発生しない)
      const created = await tx.riskIssue.create({
        data: {
          tenantId,
          projectId: newProjectId,
          type: r.type,
          title: r.title,
          occurrence: r.occurrence,
          content: r.content,
          cause: r.cause,
          impact: r.impact,
          likelihood: r.likelihood,
          priority: r.priority,
          responsePolicy: r.responsePolicy,
          responseDetail: r.responseDetail,
          deadline: r.deadline,
          state: r.state,
          result: r.result,
          lessonLearned: r.lessonLearned,
          visibility: r.visibility,
          riskNature: r.riskNature,
          isSeedSample: true,
          reporterId: userId,
          createdBy: userId,
          updatedBy: userId,
        },
        select: { id: true },
      });
      // 一覧は M:N (riskIssueProjects) 経由のため連結を作成する
      await tx.riskIssueProject.create({
        data: { riskIssueId: created.id, projectId: newProjectId },
      });
      embeddingCopies.push({ table: 'risks_issues', srcId: r.id, newId: created.id });
      s.risksIssues += 1;
    }

    // 3-5. 振り返り (同上)
    for (const retro of sourceRetros) {
      const newProjectId = retro.projectId ? projectIdMap.get(retro.projectId) : undefined;
      if (!newProjectId) continue;
      const created = await tx.retrospective.create({
        data: {
          tenantId,
          projectId: newProjectId,
          conductedDate: retro.conductedDate,
          planSummary: retro.planSummary,
          actualSummary: retro.actualSummary,
          goodPoints: retro.goodPoints,
          problems: retro.problems,
          estimateGapFactors: retro.estimateGapFactors,
          scheduleGapFactors: retro.scheduleGapFactors,
          qualityIssues: retro.qualityIssues,
          riskResponseEvaluation: retro.riskResponseEvaluation,
          improvements: retro.improvements,
          knowledgeToShare: retro.knowledgeToShare,
          state: retro.state,
          visibility: retro.visibility,
          isSeedSample: true,
          createdBy: userId,
          updatedBy: userId,
        },
        select: { id: true },
      });
      await tx.retrospectiveProject.create({
        data: { retrospectiveId: created.id, projectId: newProjectId },
      });
      embeddingCopies.push({ table: 'retrospectives', srcId: retro.id, newId: created.id });
      s.retrospectives += 1;
    }

    // 3-6. embedding を複製元からそのままコピー (Voyage 再呼出なし = 課金ゼロ)。
    //   Prisma の Unsupported("vector(1024)") 型は通常 update では書けないため raw SQL で UPDATE する。
    //   複製元 (管理テナント) 行を id で SELECT し、複製先 (実行者テナント) 行に書き込む。
    //   WHERE に tenant_id を付けて越境書込を遮断する。
    for (const c of embeddingCopies) {
      // table は固定の許可リスト由来 (ユーザ入力ではない) のため安全。
      await tx.$executeRawUnsafe(
        `UPDATE "${c.table}" SET "content_embedding" = (` +
          `SELECT "content_embedding" FROM "${c.table}" WHERE id = $1::uuid` +
          `) WHERE id = $2::uuid AND tenant_id = $3::uuid`,
        c.srcId,
        c.newId,
        tenantId,
      );
    }

    return s;
  });

  // ---------- 4. 監査ログ (テナント全体に影響するため必ず記録) ----------
  await recordAuditLog({
    tenantId,
    userId,
    action: 'CREATE',
    entityType: 'sample_data_import',
    entityId: tenantId,
    afterValue: { ...summary },
  });

  return { ok: true, summary };
}

/**
 * 自テナントのスターターデータ (isSeedSample=true) を一括削除する。
 *
 * 物理削除を依存順に行う (= 使い捨てサンプルのため。論理削除では Customer の NOT NULL
 * customer_id FK と整合が取れず、DB 容量も解放されないため)。
 * `tenantId` + `isSeedSample=true` でスコープを限定するため、他テナントや通常データには触れない。
 */
export async function deleteSampleData(args: {
  tenantId: string;
  userId: string;
}): Promise<DeleteSampleDataResult> {
  const { tenantId, userId } = args;

  const summary = await prisma.$transaction(async (tx) => {
    const s: SampleCloneSummary = { ...EMPTY_SUMMARY };

    // 削除対象 id を収集 (テナント隔離 + マーカーで厳格スコープ)。
    //   risks/retros/projects は M:N 連結の掃除に id 群が要る。knowledge/customers は
    //   where 句 (tenantId + isSeedSample) で直接 deleteMany するため id 収集は不要。
    const [risks, retros, projects, customerCount] = await Promise.all([
      tx.riskIssue.findMany({ where: { tenantId, isSeedSample: true }, select: { id: true } }),
      tx.retrospective.findMany({ where: { tenantId, isSeedSample: true }, select: { id: true } }),
      tx.project.findMany({ where: { tenantId, isSeedSample: true }, select: { id: true } }),
      tx.customer.count({ where: { tenantId, isSeedSample: true } }),
    ]);
    const riskIds = risks.map((r) => r.id);
    const retroIds = retros.map((r) => r.id);
    const projectIds = projects.map((p) => p.id);

    // 依存順: M:N 連結 → 課題/リスク・振り返り → ナレッジ → プロジェクト → 顧客
    if (riskIds.length) {
      await tx.riskIssueProject.deleteMany({ where: { riskIssueId: { in: riskIds } } });
      const d = await tx.riskIssue.deleteMany({ where: { tenantId, isSeedSample: true } });
      s.risksIssues = d.count;
    }
    if (retroIds.length) {
      await tx.retrospectiveProject.deleteMany({ where: { retrospectiveId: { in: retroIds } } });
      const d = await tx.retrospective.deleteMany({ where: { tenantId, isSeedSample: true } });
      s.retrospectives = d.count;
    }
    {
      const d = await tx.knowledge.deleteMany({ where: { tenantId, isSeedSample: true } });
      s.knowledge = d.count;
    }
    if (projectIds.length) {
      // 念のため複製プロジェクト由来の M:N 連結を掃除 (risks/retros 削除済なら空のはず)
      await tx.riskIssueProject.deleteMany({ where: { projectId: { in: projectIds } } });
      await tx.retrospectiveProject.deleteMany({ where: { projectId: { in: projectIds } } });
      await tx.knowledgeProject.deleteMany({ where: { projectId: { in: projectIds } } });
      const d = await tx.project.deleteMany({ where: { tenantId, isSeedSample: true } });
      s.projects = d.count;
    }
    if (customerCount > 0) {
      const d = await tx.customer.deleteMany({ where: { tenantId, isSeedSample: true } });
      s.customers = d.count;
    }

    return s;
  });

  await recordAuditLog({
    tenantId,
    userId,
    action: 'DELETE',
    entityType: 'sample_data_import',
    entityId: tenantId,
    afterValue: { ...summary },
  });

  return { ok: true, summary };
}

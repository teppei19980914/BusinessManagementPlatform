/**
 * プロジェクトサービス (本プロダクトのトップエンティティ)
 *
 * 役割:
 *   プロジェクトを CRUD し、状態遷移 (企画中 → 見積中 → 計画中 → 実行中 → 完了 →
 *   振り返り完了 → クローズ) を管理する。リスク・タスク・見積もり・振り返りなど、
 *   ほぼすべての業務エンティティが Project を親に持つ。
 *
 * 設計判断:
 *   - 論理削除 (deletedAt) を採用。クローズ後も振り返り・ナレッジ参照のため残す。
 *   - 状態遷移は state-machine.ts に集約。直接 status を更新する経路は禁止し、
 *     必ず changeProjectStatus() 経由にすることで「逆戻り禁止」「飛び級禁止」を強制する。
 *   - businessDomainTags / techStackTags / processTags はいずれも JSONB 配列。
 *     提案型サービス (suggestion.service.ts) で過去ナレッジ/課題とのマッチングに使用。
 *   - createdBy / updatedBy は監査の最低限。詳細な変更履歴は audit_logs に別途記録。
 *
 * 認可:
 *   呼び出し元 API ルート (/api/projects/...) で checkProjectPermission または
 *   requireAdmin を実施済みの前提。本サービスは membership / role の判定を行わない。
 *
 * 関連ドキュメント:
 *   - DESIGN.md §5 (テーブル定義: projects)
 *   - DESIGN.md §6 (プロジェクト状態遷移設計)
 *   - DESIGN.md §8 (権限制御)
 *   - DESIGN.md §23 (核心機能: 提案型サービスでのタグ参照)
 */

import { prisma } from '@/lib/db';
import { canTransition } from './state-machine';
import type { Prisma } from '@/generated/prisma/client';
import type { ProjectStatus } from '@/types';

export type ProjectDTO = {
  id: string;
  name: string;
  // PR #111-2: customerId が真の所有項目。customerName は customer.name の派生値
  // (UI 表示用に常に include してセットする)。
  customerId: string;
  customerName: string;
  purpose: string;
  background: string;
  scope: string;
  outOfScope: string | null;
  devMethod: string;
  // PR-β / 項目 14: 契約形態 (新設、既存プロジェクトは null)
  contractType: string | null;
  businessDomainTags: string[];
  techStackTags: string[];
  processTags: string[];
  plannedStartDate: string;
  plannedEndDate: string;
  status: string;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

// 一覧/詳細で prisma から取得する行の形 (include: { customer: { select: { name } } } 前提)
type ProjectRowWithCustomer = {
  id: string;
  name: string;
  customerId: string;
  customer: { name: string };
  purpose: string;
  background: string;
  scope: string;
  outOfScope: string | null;
  devMethod: string;
  contractType: string | null;
  businessDomainTags: Prisma.JsonValue;
  techStackTags: Prisma.JsonValue;
  processTags: Prisma.JsonValue;
  plannedStartDate: Date;
  plannedEndDate: Date;
  status: string;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

function toProjectDTO(p: ProjectRowWithCustomer): ProjectDTO {
  return {
    id: p.id,
    name: p.name,
    customerId: p.customerId,
    customerName: p.customer.name,
    purpose: p.purpose,
    background: p.background,
    scope: p.scope,
    outOfScope: p.outOfScope,
    devMethod: p.devMethod,
    contractType: p.contractType,
    businessDomainTags: (p.businessDomainTags as string[]) || [],
    techStackTags: (p.techStackTags as string[]) || [],
    processTags: (p.processTags as string[]) || [],
    plannedStartDate: p.plannedStartDate.toISOString().split('T')[0],
    plannedEndDate: p.plannedEndDate.toISOString().split('T')[0],
    status: p.status,
    notes: p.notes,
    createdBy: p.createdBy,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export type ListProjectsParams = {
  keyword?: string;
  customerName?: string;
  // PR #111-2: 顧客詳細画面から「この顧客の active Project」一覧を取るために追加
  customerId?: string;
  status?: string;
  page?: number;
  limit?: number;
};

export async function listProjects(
  params: ListProjectsParams,
  userId: string,
  systemRole: string,
): Promise<{ data: ProjectDTO[]; total: number }> {
  const page = params.page || 1;
  const limit = Math.min(params.limit || 20, 100);
  const skip = (page - 1) * limit;

  const where: Prisma.ProjectWhereInput = { deletedAt: null };

  // 一般ユーザは自分がメンバーのプロジェクトのみ
  if (systemRole !== 'admin') {
    where.members = { some: { userId } };
  }

  if (params.status) {
    where.status = params.status;
  }
  // PR #111-2: customerName フィルタは customer.name の relation filter に変換する。
  // 呼び出し元 (API layer) のクエリパラメータ名は既存互換のため維持する。
  if (params.customerName) {
    where.customer = { name: { contains: params.customerName, mode: 'insensitive' } };
  }
  // PR #111-2: 顧客詳細画面用の customerId 直接フィルタ
  if (params.customerId) {
    where.customerId = params.customerId;
  }
  if (params.keyword) {
    where.OR = [
      { name: { contains: params.keyword, mode: 'insensitive' } },
      { customer: { name: { contains: params.keyword, mode: 'insensitive' } } },
      { purpose: { contains: params.keyword, mode: 'insensitive' } },
    ];
  }

  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where,
      include: { customer: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.project.count({ where }),
  ]);

  return { data: projects.map(toProjectDTO), total };
}

// null は明示クリア用 (validator schema で .nullable() 済、§5.12)
export type CreateProjectInput = {
  name: string;
  customerId: string;
  purpose: string;
  background: string;
  scope: string;
  outOfScope?: string | null;
  devMethod: string;
  // PR-β / 項目 14: 契約形態 (新設、null 許容)
  contractType?: string | null;
  businessDomainTags?: string[];
  techStackTags?: string[];
  processTags?: string[];
  plannedStartDate: string;
  plannedEndDate: string;
  notes?: string | null;
};

export async function createProject(
  input: CreateProjectInput,
  userId: string,
): Promise<ProjectDTO> {
  const project = await prisma.project.create({
    data: {
      name: input.name,
      customerId: input.customerId,
      purpose: input.purpose,
      background: input.background,
      scope: input.scope,
      outOfScope: input.outOfScope,
      devMethod: input.devMethod,
      contractType: input.contractType ?? null,
      businessDomainTags: (input.businessDomainTags || []) as Prisma.InputJsonValue,
      techStackTags: (input.techStackTags || []) as Prisma.InputJsonValue,
      processTags: (input.processTags || []) as Prisma.InputJsonValue,
      plannedStartDate: new Date(input.plannedStartDate),
      plannedEndDate: new Date(input.plannedEndDate),
      notes: input.notes,
      status: 'planning',
      createdBy: userId,
      updatedBy: userId,
    },
    include: { customer: { select: { name: true } } },
  });

  return toProjectDTO(project);
}

export async function getProject(projectId: string): Promise<ProjectDTO | null> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    include: { customer: { select: { name: true } } },
  });
  return project ? toProjectDTO(project) : null;
}

export type UpdateProjectInput = Partial<CreateProjectInput>;

export async function updateProject(
  projectId: string,
  input: UpdateProjectInput,
  userId: string,
): Promise<ProjectDTO> {
  const data: Prisma.ProjectUpdateInput = { updatedBy: userId };

  if (input.name !== undefined) data.name = input.name;
  // PR #111-2: customerId 変更時は relation の connect() 経由で切り替える。
  if (input.customerId !== undefined) {
    data.customer = { connect: { id: input.customerId } };
  }
  if (input.purpose !== undefined) data.purpose = input.purpose;
  if (input.background !== undefined) data.background = input.background;
  if (input.scope !== undefined) data.scope = input.scope;
  if (input.outOfScope !== undefined) data.outOfScope = input.outOfScope;
  if (input.devMethod !== undefined) data.devMethod = input.devMethod;
  if (input.contractType !== undefined) data.contractType = input.contractType;
  if (input.businessDomainTags !== undefined)
    data.businessDomainTags = input.businessDomainTags as Prisma.InputJsonValue;
  if (input.techStackTags !== undefined)
    data.techStackTags = input.techStackTags as Prisma.InputJsonValue;
  if (input.processTags !== undefined)
    data.processTags = input.processTags as Prisma.InputJsonValue;
  if (input.plannedStartDate !== undefined)
    data.plannedStartDate = new Date(input.plannedStartDate);
  if (input.plannedEndDate !== undefined)
    data.plannedEndDate = new Date(input.plannedEndDate);
  if (input.notes !== undefined) data.notes = input.notes;

  const project = await prisma.project.update({
    where: { id: projectId },
    data,
    include: { customer: { select: { name: true } } },
  });

  return toProjectDTO(project);
}

/**
 * プロジェクトの状態遷移を実行する。
 *
 * 重要: このサービスは status を直接更新する**唯一の経路**。updateProject() では
 * status を更新しないため、状態遷移は必ず本関数を経由する。
 *
 * 遷移ルールは src/services/state-machine.ts の `canTransition` で集約管理:
 *   - 逆戻り禁止: 「実行中 → 計画中」のような後退は許可しない
 *   - 飛び級禁止: 必ず順序通りに進める (planning → estimating → scheduling → executing → ...)
 *
 * エラー:
 *   - NOT_FOUND: プロジェクトが存在しない or 論理削除済み
 *   - STATE_CONFLICT:<reason>: 遷移ルール違反 (理由付き)
 *
 * 認可: 呼び出し元 API ルートで checkProjectPermission('project:change_status') 実施済の前提。
 */
export async function changeProjectStatus(
  projectId: string,
  newStatus: ProjectStatus,
  userId: string,
): Promise<ProjectDTO> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
  });

  if (!project) throw new Error('NOT_FOUND');

  // 状態遷移ルールの単一の真実 = state-machine.ts に委譲。
  // 業務ルール変更時は state-machine.ts 1 箇所を編集すればよい。
  const currentStatus = project.status as ProjectStatus;
  const transition = canTransition(currentStatus, newStatus);

  if (!transition.allowed) {
    // API ルート側で 409 STATE_CONFLICT に変換される。エラーメッセージは
    // 'STATE_CONFLICT:' プレフィックスで判別可能。
    throw new Error(`STATE_CONFLICT:${transition.reason}`);
  }

  const updated = await prisma.project.update({
    where: { id: projectId },
    data: { status: newStatus, updatedBy: userId },
    include: { customer: { select: { name: true } } },
  });

  return toProjectDTO(updated);
}

export async function deleteProject(projectId: string, userId: string): Promise<void> {
  // PR #89: プロジェクト scoped の Attachment (project / task / estimate) も同時に論理削除。
  // 子 risk / retro / knowledge の attachment は各 delete*Service 側で削除済 (個別削除パス)、
  // もしくは cascade で削除する (deleteProjectCascade)。
  // 論理削除パスでは親プロジェクトが消えても子 entity は残るが、UI の一覧ビューは
  // deletedAt フィルタにより該当プロジェクトの attachment を表示しなくなる。
  const now = new Date();
  const [tasks, estimates] = await Promise.all([
    prisma.task.findMany({
      where: { projectId, deletedAt: null },
      select: { id: true },
    }),
    prisma.estimate.findMany({
      where: { projectId, deletedAt: null },
      select: { id: true },
    }),
  ]);

  await prisma.$transaction([
    prisma.project.update({
      where: { id: projectId },
      data: { deletedAt: now, updatedBy: userId },
    }),
    prisma.attachment.updateMany({
      where: { entityType: 'project', entityId: projectId, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.attachment.updateMany({
      where: {
        entityType: 'task',
        entityId: { in: tasks.map((t) => t.id) },
        deletedAt: null,
      },
      data: { deletedAt: now },
    }),
    prisma.attachment.updateMany({
      where: {
        entityType: 'estimate',
        entityId: { in: estimates.map((e) => e.id) },
        deletedAt: null,
      },
      data: { deletedAt: now },
    }),
  ]);
}

/**
 * プロジェクトと紐づく全データをカスケード物理削除する (2026-04-18 / PR #89 で細粒度化)。
 *
 * 強制削除対象 (options に関係なく常に物理削除):
 *   - Project 自身
 *   - Task + TaskProgressLog (WBS / ガント)
 *   - Estimate (見積)
 *   - ProjectMember
 *   - Attachment: project / task / estimate 配下 + 削除対象となる risk / retro / knowledge 配下
 *
 * 条件付き削除 (PR #89 の細粒度確認ダイアログから渡すフラグ):
 *   - cascadeRisks      : RiskIssue (type='risk') を物理削除するか
 *   - cascadeIssues     : RiskIssue (type='issue') を物理削除するか
 *   - cascadeRetros     : Retrospective + RetrospectiveComment を物理削除するか
 *   - cascadeKnowledge  : Knowledge を物理削除 (N:M 考慮)、または紐付けのみ解除
 *
 * フラグが false の場合:
 *   - 該当エンティティ本体は残す (全○○ ビューから引き続き参照可能)
 *   - Attachment も残す (全○○ 画面で添付 URL が見える)
 *   - ただし project_id は「存在しないプロジェクト」を参照した孤児状態
 *     → 全○○ ビュー側で projectDeleted / projectName マスクする既存処理で対応 (PR #52)
 */
export async function deleteProjectCascade(
  projectId: string,
  options: {
    cascadeRisks?: boolean;
    cascadeIssues?: boolean;
    cascadeRetros?: boolean;
    cascadeKnowledge?: boolean;
  } = {},
): Promise<{
  risks: number;
  issues: number;
  retrospectives: number;
  knowledgeDeleted: number;
  knowledgeUnlinked: number;
  attachmentsDeleted: number;
}> {
  const {
    cascadeRisks = false,
    cascadeIssues = false,
    cascadeRetros = false,
    cascadeKnowledge = false,
  } = options;

  let risksCount = 0;
  let issuesCount = 0;
  let retrosCount = 0;
  let knowledgeDeleted = 0;
  let knowledgeUnlinked = 0;
  let attachmentsDeleted = 0;

  // 強制削除候補の ID を先に取得 (後で attachment 削除にも使う)
  const [tasks, estimates] = await Promise.all([
    prisma.task.findMany({ where: { projectId }, select: { id: true } }),
    prisma.estimate.findMany({ where: { projectId }, select: { id: true } }),
  ]);
  const taskIds = tasks.map((t) => t.id);
  const estimateIds = estimates.map((e) => e.id);

  // ---------- 条件付き: リスク (type='risk') ----------
  if (cascadeRisks) {
    const riskIds = (
      await prisma.riskIssue.findMany({
        where: { projectId, type: 'risk' },
        select: { id: true },
      })
    ).map((r) => r.id);
    if (riskIds.length > 0) {
      const attRes = await prisma.attachment.deleteMany({
        where: { entityType: 'risk', entityId: { in: riskIds } },
      });
      attachmentsDeleted += attRes.count;
      // PR fix/visibility-auth-matrix (2026-05-01): comments も cascade 物理削除 (§5.51)
      await prisma.comment.deleteMany({
        where: { entityType: 'risk', entityId: { in: riskIds } },
      });
      const delRes = await prisma.riskIssue.deleteMany({
        where: { id: { in: riskIds } },
      });
      risksCount = delRes.count;
    }
  }

  // ---------- 条件付き: 課題 (type='issue') ----------
  if (cascadeIssues) {
    const issueIds = (
      await prisma.riskIssue.findMany({
        where: { projectId, type: 'issue' },
        select: { id: true },
      })
    ).map((i) => i.id);
    if (issueIds.length > 0) {
      const attRes = await prisma.attachment.deleteMany({
        where: { entityType: 'risk', entityId: { in: issueIds } },
      });
      attachmentsDeleted += attRes.count;
      // PR fix/visibility-auth-matrix: comments も cascade 物理削除 (§5.51)
      await prisma.comment.deleteMany({
        where: { entityType: 'issue', entityId: { in: issueIds } },
      });
      const delRes = await prisma.riskIssue.deleteMany({
        where: { id: { in: issueIds } },
      });
      issuesCount = delRes.count;
    }
  }

  // ---------- 条件付き: 振り返り ----------
  if (cascadeRetros) {
    const retroIds = (
      await prisma.retrospective.findMany({
        where: { projectId },
        select: { id: true },
      })
    ).map((r) => r.id);
    if (retroIds.length > 0) {
      const attRes = await prisma.attachment.deleteMany({
        where: { entityType: 'retrospective', entityId: { in: retroIds } },
      });
      attachmentsDeleted += attRes.count;
      // PR #199: 旧 retrospective_comments は polymorphic comments に統合済。
      //   retrospective 削除時は entityType='retrospective' のコメントも一括削除する。
      await prisma.comment.deleteMany({
        where: { entityType: 'retrospective', entityId: { in: retroIds } },
      });
      const delRes = await prisma.retrospective.deleteMany({
        where: { id: { in: retroIds } },
      });
      retrosCount = delRes.count;
    }
  }

  // ---------- 条件付き: ナレッジ ----------
  if (cascadeKnowledge) {
    const linkedKnowledge = await prisma.knowledgeProject.findMany({
      where: { projectId },
      select: { knowledgeId: true },
    });
    const knowledgeIds = linkedKnowledge.map((l) => l.knowledgeId);
    for (const kId of knowledgeIds) {
      const linkCount = await prisma.knowledgeProject.count({
        where: { knowledgeId: kId },
      });
      if (linkCount <= 1) {
        // 他に紐付けがない → 本体 + attachment + comment を物理削除
        const attRes = await prisma.attachment.deleteMany({
          where: { entityType: 'knowledge', entityId: kId },
        });
        attachmentsDeleted += attRes.count;
        // PR fix/visibility-auth-matrix: comments も cascade 物理削除 (§5.51)
        await prisma.comment.deleteMany({
          where: { entityType: 'knowledge', entityId: kId },
        });
        await prisma.knowledgeProject.deleteMany({ where: { knowledgeId: kId } });
        await prisma.knowledge.delete({ where: { id: kId } });
        knowledgeDeleted++;
      } else {
        // 他プロジェクトとも共有 → 紐付けのみ解除 (本体・attachment は残す)
        await prisma.knowledgeProject.delete({
          where: { knowledgeId_projectId: { knowledgeId: kId, projectId } },
        });
        knowledgeUnlinked++;
      }
    }
  }

  // ---------- 強制削除: Task / Estimate / ProjectMember / Project + Attachments ----------
  if (taskIds.length > 0) {
    await prisma.taskProgressLog.deleteMany({ where: { taskId: { in: taskIds } } });
    const attTaskRes = await prisma.attachment.deleteMany({
      where: { entityType: 'task', entityId: { in: taskIds } },
    });
    attachmentsDeleted += attTaskRes.count;
    // PR fix/visibility-auth-matrix: task comments も cascade 物理削除 (§5.51)
    await prisma.comment.deleteMany({
      where: { entityType: 'task', entityId: { in: taskIds } },
    });
  }
  if (estimateIds.length > 0) {
    const attEstRes = await prisma.attachment.deleteMany({
      where: { entityType: 'estimate', entityId: { in: estimateIds } },
    });
    attachmentsDeleted += attEstRes.count;
  }
  const attProjRes = await prisma.attachment.deleteMany({
    where: { entityType: 'project', entityId: projectId },
  });
  attachmentsDeleted += attProjRes.count;

  await prisma.task.deleteMany({ where: { projectId } });
  await prisma.estimate.deleteMany({ where: { projectId } });
  await prisma.projectMember.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });

  return {
    risks: risksCount,
    issues: issuesCount,
    retrospectives: retrosCount,
    knowledgeDeleted,
    knowledgeUnlinked,
    attachmentsDeleted,
  };
}

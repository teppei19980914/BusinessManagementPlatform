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
  customerName: string;
  purpose: string;
  background: string;
  scope: string;
  outOfScope: string | null;
  devMethod: string;
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

function toProjectDTO(p: {
  id: string;
  name: string;
  customerName: string;
  purpose: string;
  background: string;
  scope: string;
  outOfScope: string | null;
  devMethod: string;
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
}): ProjectDTO {
  return {
    id: p.id,
    name: p.name,
    customerName: p.customerName,
    purpose: p.purpose,
    background: p.background,
    scope: p.scope,
    outOfScope: p.outOfScope,
    devMethod: p.devMethod,
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
  if (params.customerName) {
    where.customerName = { contains: params.customerName, mode: 'insensitive' };
  }
  if (params.keyword) {
    where.OR = [
      { name: { contains: params.keyword, mode: 'insensitive' } },
      { customerName: { contains: params.keyword, mode: 'insensitive' } },
      { purpose: { contains: params.keyword, mode: 'insensitive' } },
    ];
  }

  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.project.count({ where }),
  ]);

  return { data: projects.map(toProjectDTO), total };
}

export type CreateProjectInput = {
  name: string;
  customerName: string;
  purpose: string;
  background: string;
  scope: string;
  outOfScope?: string;
  devMethod: string;
  businessDomainTags?: string[];
  techStackTags?: string[];
  processTags?: string[];
  plannedStartDate: string;
  plannedEndDate: string;
  notes?: string;
};

export async function createProject(
  input: CreateProjectInput,
  userId: string,
): Promise<ProjectDTO> {
  const project = await prisma.project.create({
    data: {
      name: input.name,
      customerName: input.customerName,
      purpose: input.purpose,
      background: input.background,
      scope: input.scope,
      outOfScope: input.outOfScope,
      devMethod: input.devMethod,
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
  });

  return toProjectDTO(project);
}

export async function getProject(projectId: string): Promise<ProjectDTO | null> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
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
  if (input.customerName !== undefined) data.customerName = input.customerName;
  if (input.purpose !== undefined) data.purpose = input.purpose;
  if (input.background !== undefined) data.background = input.background;
  if (input.scope !== undefined) data.scope = input.scope;
  if (input.outOfScope !== undefined) data.outOfScope = input.outOfScope;
  if (input.devMethod !== undefined) data.devMethod = input.devMethod;
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
  });

  return toProjectDTO(updated);
}

export async function deleteProject(projectId: string, userId: string): Promise<void> {
  await prisma.project.update({
    where: { id: projectId },
    data: { deletedAt: new Date(), updatedBy: userId },
  });
}

/**
 * プロジェクトと紐づく全データをカスケード物理削除する (2026-04-18 追加)。
 *
 * 対象:
 *   - Project 自身 (物理削除)
 *   - RiskIssue, Retrospective, RetrospectiveComment (1:N 紐付け → 全削除)
 *   - Task, ProjectMember, Estimate 等の関連データ (全削除)
 *   - Knowledge (N:M 紐付け):
 *       * この projectId しか紐付けがないナレッジ → 物理削除
 *       * 他プロジェクトとも紐付いているナレッジ → KnowledgeProject リンクのみ削除
 *     (他プロジェクトに影響しないよう配慮)
 *
 * 「紐付くデータを物理削除」という UX の結果、復旧不可能。呼び出し側で必ず
 * 確認ダイアログを挟むこと。
 */
export async function deleteProjectCascade(projectId: string): Promise<{
  risks: number;
  retrospectives: number;
  knowledgeDeleted: number;
  knowledgeUnlinked: number;
}> {
  // カスケード順序は Prisma の onDelete 指定次第だが、明示的に削除して
  // 参照整合を破壊せず確実に掃除する。
  const retroComments = await prisma.retrospective.findMany({
    where: { projectId },
    select: { id: true },
  });
  const retroIds = retroComments.map((r) => r.id);

  // リスク/課題
  const risksResult = await prisma.riskIssue.deleteMany({ where: { projectId } });
  // 振り返りコメント → 振り返り本体の順で削除 (FK 制約対応)
  if (retroIds.length > 0) {
    await prisma.retrospectiveComment.deleteMany({ where: { retrospectiveId: { in: retroIds } } });
  }
  const retrosResult = await prisma.retrospective.deleteMany({ where: { projectId } });

  // ナレッジ: N:M 考慮
  // 1) この project に紐付いている knowledge を抽出
  const linkedKnowledge = await prisma.knowledgeProject.findMany({
    where: { projectId },
    select: { knowledgeId: true },
  });
  const knowledgeIds = linkedKnowledge.map((l) => l.knowledgeId);

  // 2) 各 knowledge の他プロジェクト紐付け件数を確認
  let knowledgeDeleted = 0;
  let knowledgeUnlinked = 0;
  for (const kId of knowledgeIds) {
    const linkCount = await prisma.knowledgeProject.count({ where: { knowledgeId: kId } });
    if (linkCount <= 1) {
      // 他に紐付けがない → 本体も物理削除
      await prisma.knowledgeProject.deleteMany({ where: { knowledgeId: kId } });
      await prisma.knowledge.delete({ where: { id: kId } });
      knowledgeDeleted++;
    } else {
      // 他プロジェクトとも共有 → このプロジェクトとの紐付けだけ解除
      await prisma.knowledgeProject.delete({
        where: { knowledgeId_projectId: { knowledgeId: kId, projectId } },
      });
      knowledgeUnlinked++;
    }
  }

  // タスク進捗ログ → タスク → 見積 → メンバー → プロジェクトの順
  const tasks = await prisma.task.findMany({ where: { projectId }, select: { id: true } });
  const taskIds = tasks.map((t) => t.id);
  if (taskIds.length > 0) {
    await prisma.taskProgressLog.deleteMany({ where: { taskId: { in: taskIds } } });
  }
  await prisma.task.deleteMany({ where: { projectId } });
  await prisma.estimate.deleteMany({ where: { projectId } });
  await prisma.projectMember.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });

  return {
    risks: risksResult.count,
    retrospectives: retrosResult.count,
    knowledgeDeleted,
    knowledgeUnlinked,
  };
}

/**
 * リスク・課題サービス
 *
 * 役割:
 *   プロジェクト運営中に発生する「リスク」(risk: 将来発生し得る事象) と
 *   「課題」(issue: 既に発生した事象) を統一テーブル risks_issues で管理する。
 *   2 種類は type 列で区別し、UI/権限/バリデーションは共通化している。
 *
 * 設計判断:
 *   - 統一テーブル: 90% の項目が共通 (タイトル / 内容 / 影響度 / 状態 / 担当 / 期限) のため
 *     1 テーブルで管理。risk のみ likelihood / risk_nature を持ち、issue は null 許容。
 *   - 公開範囲 (visibility, PR #60): draft / public の 2 値
 *   - 脅威/好機分類 (riskNature, PR #60): risk の場合のみ threat / opportunity を持つ
 *     PMBOK 第 7 版の「機会 (opportunity)」概念に対応するため
 *   - 論理削除 (deletedAt) を採用。クローズ後も振り返りで参照するため
 *   - title / content に pg_trgm GIN インデックス (PR #65)
 *     → type='issue' かつ state='resolved' を「過去課題」として新案件に提案
 *
 * 認可:
 *   呼び出し元 API ルート (/api/projects/[id]/risks/...) で
 *   checkProjectPermission('risk:*' / 'issue:*') を実施済みの前提。
 *   listRisks() の visibility フィルタは内部で適用 (作成者本人 + admin は draft も見える)。
 *
 * 関連ドキュメント:
 *   - DESIGN.md §5 (テーブル定義: risks_issues)
 *   - DESIGN.md §8 (権限制御 — risk アクション)
 *   - DESIGN.md §23 (核心機能: 過去課題の提案)
 *   - SPECIFICATION.md (リスク・課題管理画面 / 全リスク・全課題画面)
 */

import { prisma } from '@/lib/db';
// Prisma types used for Decimal handling in toRiskDTO
import type { CreateRiskInput } from '@/lib/validators/risk';

export type RiskDTO = {
  id: string;
  projectId: string;
  type: string;
  title: string;
  content: string;
  cause: string | null;
  impact: string;
  likelihood: string | null;
  priority: string;
  responsePolicy: string | null;
  responseDetail: string | null;
  reporterId: string;
  reporterName?: string;
  assigneeId: string | null;
  assigneeName?: string | null;
  deadline: string | null;
  state: string;
  result: string | null;
  lessonLearned: string | null;
  // PR #60
  visibility: string;
  riskNature: string | null;
  createdAt: string;
  updatedAt: string;
};

function toRiskDTO(r: {
  id: string;
  projectId: string;
  type: string;
  title: string;
  content: string;
  cause: string | null;
  impact: string;
  likelihood: string | null;
  priority: string;
  responsePolicy: string | null;
  responseDetail: string | null;
  reporterId: string;
  reporter?: { name: string };
  assigneeId: string | null;
  assignee?: { name: string } | null;
  deadline: Date | null;
  state: string;
  result: string | null;
  lessonLearned: string | null;
  visibility: string;
  riskNature: string | null;
  createdAt: Date;
  updatedAt: Date;
}): RiskDTO {
  return {
    id: r.id,
    projectId: r.projectId,
    type: r.type,
    title: r.title,
    content: r.content,
    cause: r.cause,
    impact: r.impact,
    likelihood: r.likelihood,
    priority: r.priority,
    responsePolicy: r.responsePolicy,
    responseDetail: r.responseDetail,
    reporterId: r.reporterId,
    reporterName: r.reporter?.name,
    assigneeId: r.assigneeId,
    assigneeName: r.assignee?.name,
    deadline: r.deadline?.toISOString().split('T')[0] ?? null,
    state: r.state,
    result: r.result,
    lessonLearned: r.lessonLearned,
    visibility: r.visibility,
    riskNature: r.riskNature,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listRisks(
  projectId: string,
  viewerUserId: string,
  viewerSystemRole: string,
): Promise<RiskDTO[]> {
  const isAdmin = viewerSystemRole === 'admin';
  // PR #60: 非 admin は public + 自身の draft (起票者) のみ
  const visibilityWhere = isAdmin
    ? {}
    : { OR: [{ visibility: 'public' }, { visibility: 'draft', reporterId: viewerUserId }] };

  const risks = await prisma.riskIssue.findMany({
    where: { projectId, deletedAt: null, ...visibilityWhere },
    include: {
      reporter: { select: { name: true } },
      assignee: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return risks.map(toRiskDTO);
}

/**
 * 「全リスク/課題」ビュー用 DTO。
 * 閲覧ユーザが紐づくプロジェクトの ProjectMember か否かで情報量を切り替える:
 *   - メンバー: projectName 見える + canAccessProject=true (詳細リンク表示)
 *   - 非メンバー: projectName / 顧客情報を一律マスク + canAccessProject=false
 * 担当者名 / 起票者名も「非メンバーには氏名非公開」とする (顧客情報に準ずる機微情報)
 */
export type AllRiskDTO = Omit<RiskDTO, 'assigneeName' | 'reporterName'> & {
  projectName: string | null;
  /** プロジェクトが論理削除済みか (admin のみ識別可、非 admin には null として秘匿) */
  projectDeleted: boolean;
  canAccessProject: boolean;
  reporterName: string | null;
  assigneeName: string | null;
  /** 作成者氏名 (非メンバーにはマスク) */
  createdByName: string | null;
  /** 更新者氏名 (非メンバーにはマスク) */
  updatedByName: string | null;
};

/**
 * 全プロジェクトのリスク/課題を取得する (認可: ログインユーザなら誰でも可)。
 * 非メンバーの場合は projectName / 顧客名 / 担当者氏名をマスクする。
 * システム管理者 (systemRole='admin') は全プロジェクトのメンバー相当として
 * マスキング対象外 (projectName / 氏名すべて閲覧可 + 編集/削除権限あり)。
 */
export async function listAllRisksForViewer(
  viewerUserId: string,
  viewerSystemRole: string,
): Promise<AllRiskDTO[]> {
  const isAdmin = viewerSystemRole === 'admin';
  // ユーザが所属するプロジェクト ID 集合を先に取得 (非メンバー判定に使う)
  // admin の場合はこの後の判定で常に isMember=true として扱う
  const memberships = isAdmin
    ? []
    : await prisma.projectMember.findMany({
      where: { userId: viewerUserId },
      select: { projectId: true },
    });
  const memberProjectIds = new Set(memberships.map((m) => m.projectId));

  // PR #60: 非 admin は public + 自身の draft のみ
  const visibilityWhere = isAdmin
    ? {}
    : { OR: [{ visibility: 'public' }, { visibility: 'draft', reporterId: viewerUserId }] };

  const risks = await prisma.riskIssue.findMany({
    where: { deletedAt: null, ...visibilityWhere },
    include: {
      reporter: { select: { name: true } },
      assignee: { select: { name: true } },
      project: { select: { id: true, name: true, deletedAt: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  // createdBy / updatedBy は scalar カラムで User リレーションが張られていないため、
  // 関連ユーザ名をバルクで 1 クエリ取得して map 引きする (N+1 回避)。
  const userIds = Array.from(new Set(risks.flatMap((r) => [r.createdBy, r.updatedBy])));
  const users = userIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  const userNameById = new Map(users.map((u) => [u.id, u.name]));

  return risks.map((r) => {
    const isMember = isAdmin || memberProjectIds.has(r.projectId);
    const projectDeleted = r.project?.deletedAt != null;
    return {
      ...toRiskDTO(r),
      projectName: isMember ? r.project?.name ?? null : null,
      projectDeleted: isAdmin ? projectDeleted : false, // admin 以外には削除状態を秘匿
      // 孤児プロジェクト (deleted) への詳細リンクは admin 以外は許可しない
      canAccessProject: isMember && !projectDeleted,
      // 非メンバーには氏名を返さない (顧客名・見積と同等の機微情報扱い)
      reporterName: isMember ? r.reporter?.name ?? null : null,
      assigneeName: isMember ? r.assignee?.name ?? null : null,
      createdByName: isMember ? userNameById.get(r.createdBy) ?? null : null,
      updatedByName: isMember ? userNameById.get(r.updatedBy) ?? null : null,
    };
  });
}

export async function getRisk(riskId: string): Promise<RiskDTO | null> {
  const r = await prisma.riskIssue.findFirst({
    where: { id: riskId, deletedAt: null },
    include: {
      reporter: { select: { name: true } },
      assignee: { select: { name: true } },
    },
  });
  return r ? toRiskDTO(r) : null;
}

export async function createRisk(
  projectId: string,
  input: CreateRiskInput,
  userId: string,
): Promise<RiskDTO> {
  const r = await prisma.riskIssue.create({
    data: {
      projectId,
      type: input.type,
      title: input.title,
      content: input.content,
      cause: input.cause,
      impact: input.impact,
      likelihood: input.likelihood,
      // PR #63: 優先度を UI から撤去。暫定で影響度を流用 (将来 impact × likelihood で自動算出予定)。
      priority: input.priority ?? input.impact,
      responsePolicy: input.responsePolicy,
      responseDetail: input.responseDetail,
      reporterId: userId,
      assigneeId: input.assigneeId,
      deadline: input.deadline ? new Date(input.deadline) : undefined,
      visibility: input.visibility ?? 'draft',
      riskNature: input.type === 'risk' ? input.riskNature : null,
      createdBy: userId,
      updatedBy: userId,
    },
    include: {
      reporter: { select: { name: true } },
      assignee: { select: { name: true } },
    },
  });
  return toRiskDTO(r);
}

export async function updateRisk(
  riskId: string,
  input: Partial<CreateRiskInput> & {
    state?: string;
    result?: string;
    lessonLearned?: string;
  },
  userId: string,
): Promise<RiskDTO> {
  const data: Record<string, unknown> = { updatedBy: userId };

  if (input.title !== undefined) data.title = input.title;
  if (input.content !== undefined) data.content = input.content;
  if (input.cause !== undefined) data.cause = input.cause;
  if (input.impact !== undefined) data.impact = input.impact;
  if (input.likelihood !== undefined) data.likelihood = input.likelihood;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.responsePolicy !== undefined) data.responsePolicy = input.responsePolicy;
  if (input.responseDetail !== undefined) data.responseDetail = input.responseDetail;
  if (input.assigneeId !== undefined) data.assigneeId = input.assigneeId;
  if (input.deadline !== undefined) data.deadline = new Date(input.deadline);
  if (input.state !== undefined) data.state = input.state;
  if (input.result !== undefined) data.result = input.result;
  if (input.lessonLearned !== undefined) data.lessonLearned = input.lessonLearned;
  if (input.visibility !== undefined) data.visibility = input.visibility;
  if (input.riskNature !== undefined) data.riskNature = input.riskNature;

  const r = await prisma.riskIssue.update({
    where: { id: riskId },
    data,
    include: {
      reporter: { select: { name: true } },
      assignee: { select: { name: true } },
    },
  });
  return toRiskDTO(r);
}

export async function deleteRisk(riskId: string, userId: string): Promise<void> {
  await prisma.riskIssue.update({
    where: { id: riskId },
    data: { deletedAt: new Date(), updatedBy: userId },
  });
}

const IMPACT_LABELS: Record<string, string> = { low: '低', medium: '中', high: '高' };
const STATE_LABELS: Record<string, string> = { open: '未対応', in_progress: '対応中', monitoring: '監視中', resolved: '解消' };

export function risksToCSV(risks: RiskDTO[]): string {
  const headers = ['種別', '件名', '影響度', '優先度', '状態', '担当者', '期限', '起票日'];
  const rows = risks.map((r) => [
    r.type === 'risk' ? 'リスク' : '課題',
    `"${r.title.replace(/"/g, '""')}"`,
    IMPACT_LABELS[r.impact] || r.impact,
    IMPACT_LABELS[r.priority] || r.priority,
    STATE_LABELS[r.state] || r.state,
    r.assigneeName || '',
    r.deadline || '',
    r.createdAt.split('T')[0],
  ]);
  const bom = '\uFEFF';
  return bom + [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
}

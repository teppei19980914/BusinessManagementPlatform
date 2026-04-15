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
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listRisks(projectId: string): Promise<RiskDTO[]> {
  const risks = await prisma.riskIssue.findMany({
    where: { projectId, deletedAt: null },
    include: {
      reporter: { select: { name: true } },
      assignee: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return risks.map(toRiskDTO);
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
      priority: input.priority,
      responsePolicy: input.responsePolicy,
      responseDetail: input.responseDetail,
      reporterId: userId,
      assigneeId: input.assigneeId,
      deadline: input.deadline ? new Date(input.deadline) : undefined,
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

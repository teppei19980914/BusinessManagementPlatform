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

export async function changeProjectStatus(
  projectId: string,
  newStatus: ProjectStatus,
  userId: string,
): Promise<ProjectDTO> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
  });

  if (!project) throw new Error('NOT_FOUND');

  const currentStatus = project.status as ProjectStatus;
  const transition = canTransition(currentStatus, newStatus);

  if (!transition.allowed) {
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

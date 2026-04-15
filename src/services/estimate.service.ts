import { prisma } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';
import type { CreateEstimateInput } from '@/lib/validators/estimate';

export type EstimateDTO = {
  id: string;
  projectId: string;
  itemName: string;
  category: string;
  devMethod: string;
  estimatedEffort: number;
  effortUnit: string;
  rationale: string;
  preconditions: string | null;
  isConfirmed: boolean;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

function toEstimateDTO(e: {
  id: string;
  projectId: string;
  itemName: string;
  category: string;
  devMethod: string;
  estimatedEffort: Prisma.Decimal;
  effortUnit: string;
  rationale: string;
  preconditions: string | null;
  isConfirmed: boolean;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}): EstimateDTO {
  return {
    id: e.id,
    projectId: e.projectId,
    itemName: e.itemName,
    category: e.category,
    devMethod: e.devMethod,
    estimatedEffort: Number(e.estimatedEffort),
    effortUnit: e.effortUnit,
    rationale: e.rationale,
    preconditions: e.preconditions,
    isConfirmed: e.isConfirmed,
    notes: e.notes,
    createdBy: e.createdBy,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

export async function listEstimates(projectId: string): Promise<EstimateDTO[]> {
  const estimates = await prisma.estimate.findMany({
    where: { projectId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  return estimates.map(toEstimateDTO);
}

export async function getEstimate(estimateId: string): Promise<EstimateDTO | null> {
  const e = await prisma.estimate.findFirst({
    where: { id: estimateId, deletedAt: null },
  });
  return e ? toEstimateDTO(e) : null;
}

export async function createEstimate(
  projectId: string,
  input: CreateEstimateInput,
  userId: string,
): Promise<EstimateDTO> {
  const e = await prisma.estimate.create({
    data: {
      projectId,
      itemName: input.itemName,
      category: input.category,
      devMethod: input.devMethod,
      estimatedEffort: input.estimatedEffort,
      effortUnit: input.effortUnit,
      rationale: input.rationale,
      preconditions: input.preconditions,
      notes: input.notes,
      createdBy: userId,
      updatedBy: userId,
    },
  });
  return toEstimateDTO(e);
}

export async function updateEstimate(
  estimateId: string,
  input: Partial<CreateEstimateInput>,
  userId: string,
): Promise<EstimateDTO> {
  const data: Record<string, unknown> = { updatedBy: userId };

  if (input.itemName !== undefined) data.itemName = input.itemName;
  if (input.category !== undefined) data.category = input.category;
  if (input.devMethod !== undefined) data.devMethod = input.devMethod;
  if (input.estimatedEffort !== undefined) data.estimatedEffort = input.estimatedEffort;
  if (input.effortUnit !== undefined) data.effortUnit = input.effortUnit;
  if (input.rationale !== undefined) data.rationale = input.rationale;
  if (input.preconditions !== undefined) data.preconditions = input.preconditions;
  if (input.notes !== undefined) data.notes = input.notes;

  const e = await prisma.estimate.update({
    where: { id: estimateId },
    data,
  });
  return toEstimateDTO(e);
}

export async function confirmEstimate(estimateId: string, userId: string): Promise<EstimateDTO> {
  const e = await prisma.estimate.update({
    where: { id: estimateId },
    data: { isConfirmed: true, updatedBy: userId },
  });
  return toEstimateDTO(e);
}

export async function deleteEstimate(estimateId: string, userId: string): Promise<void> {
  await prisma.estimate.update({
    where: { id: estimateId },
    data: { deletedAt: new Date(), updatedBy: userId },
  });
}

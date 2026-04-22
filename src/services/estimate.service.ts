/**
 * 見積もりサービス
 *
 * 役割:
 *   プロジェクトの工数見積もりを CRUD する。1 プロジェクトに複数の見積もり明細
 *   (作業項目 / 工数 / 単位 / 根拠) を持つ構造で、企画フェーズから実行フェーズへの
 *   移行 (見積もり確定) と、過去案件の見積もりナレッジ蓄積を支える。
 *
 * 設計判断:
 *   - 論理削除 (deletedAt) を採用。確定済み見積もりは履歴として後続案件の参考に
 *     使われるため物理削除しない。
 *   - estimatedEffort は DB 上 Decimal(10,2) だが UI で扱いやすくするため
 *     Number に変換して DTO に格納する (toEstimateDTO の責務)。
 *   - 工数単位 (人時 / 人日) はマスタ定数 (`EFFORT_UNITS`) を参照して保存する。
 *
 * 認可:
 *   呼び出し元の API ルート (src/app/api/projects/[projectId]/estimates/...)
 *   側で `checkProjectPermission('estimate:*')` を実施済みの前提。
 *   本サービスは認可チェックを再実行しない。
 *
 * 関連ドキュメント:
 *   - DESIGN.md §5 (テーブル定義: estimates)
 *   - DESIGN.md §8 (権限制御 — estimate アクション)
 *   - SPECIFICATION.md (見積もり画面・確定フロー)
 */

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
  // PR #89: 紐づく Attachment も同時に論理削除 (孤児データ防止)
  const now = new Date();
  await prisma.$transaction([
    prisma.estimate.update({
      where: { id: estimateId },
      data: { deletedAt: now, updatedBy: userId },
    }),
    prisma.attachment.updateMany({
      where: { entityType: 'estimate', entityId: estimateId, deletedAt: null },
      data: { deletedAt: now },
    }),
  ]);
}

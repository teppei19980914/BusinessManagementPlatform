/**
 * 昇華リンクサービス (v1.3.0 資産導線機能)
 *
 * 役割:
 *   リスクが顕在化したら「課題として昇華」、課題が解消したら「ナレッジとして昇華」する
 *   ボタン操作をサポートする。昇華は既存の createRisk / createKnowledge を呼び出して
 *   新規レコードを作成し、作成元との関連を risk_issue_promotions /
 *   issue_knowledge_promotions に記録する (M:N、再昇華の system 側ブロックはしない。
 *   UI 側で「昇華済み」バッジを出して人間の判断に委ねる)。
 *
 * 設計判断:
 *   - 昇華元は visibility='public' のみ許可 (draft は他者から不可視のため昇華 UI を出さない
 *     方針。本サービスでも defense-in-depth として再検証する)
 *   - 新規作成ロジックは risk.service.ts / knowledge.service.ts の既存関数を再利用する
 *     (作成時の embedding 生成・tenantId 明示・assignee tenant 検証等を重複させない、
 *     既存実装を徹底的に流用する開発方針)
 *   - 昇華先 (新規作成) の visibility は呼出元 input に従う (昇華ダイアログで選択、既定 draft)
 *   - tenantId は全関数で必須 (severity-1 テナント越境防止)。昇華元/昇華先の参照は常に
 *     tenantId 一致するエンティティのみに限定する
 */

import { prisma } from '@/lib/db';
import { createRisk } from './risk.service';
import type { RiskDTO } from './risk.service';
import { createKnowledge } from './knowledge.service';
import type { KnowledgeDTO } from './knowledge.service';
import type { CreateRiskInput } from '@/lib/validators/risk';
import type { CreateKnowledgeInput } from '@/lib/validators/knowledge';

export type PromotedAssetSummary = {
  id: string;
  title: string;
  visibility: string;
  promotedAt: string;
};

/**
 * リスク → 課題への昇華。
 *
 * @throws {Error} 'NOT_FOUND' — 昇華元リスクが存在しない/削除済み/テナント不一致
 * @throws {Error} 'INVALID_SOURCE_TYPE' — 昇華元が type='risk' ではない
 * @throws {Error} 'SOURCE_NOT_PUBLIC' — 昇華元が visibility='public' ではない
 */
export async function promoteRiskToIssue(
  riskId: string,
  projectId: string,
  input: CreateRiskInput,
  userId: string,
  tenantId: string,
): Promise<RiskDTO> {
  const source = await prisma.riskIssue.findFirst({
    where: { id: riskId, deletedAt: null, tenantId },
    select: { id: true, type: true, visibility: true },
  });
  if (!source) throw new Error('NOT_FOUND');
  if (source.type !== 'risk') throw new Error('INVALID_SOURCE_TYPE');
  if (source.visibility !== 'public') throw new Error('SOURCE_NOT_PUBLIC');

  const issue = await createRisk(projectId, { ...input, type: 'issue' }, userId, tenantId);

  await prisma.riskIssuePromotion.create({
    data: { riskId, issueId: issue.id, createdBy: userId },
  });

  return issue;
}

/**
 * 課題 → ナレッジへの昇華。
 *
 * @throws {Error} 'NOT_FOUND' — 昇華元課題が存在しない/削除済み/テナント不一致
 * @throws {Error} 'INVALID_SOURCE_TYPE' — 昇華元が type='issue' ではない
 * @throws {Error} 'SOURCE_NOT_PUBLIC' — 昇華元が visibility='public' ではない
 */
export async function promoteIssueToKnowledge(
  issueId: string,
  input: CreateKnowledgeInput,
  userId: string,
  tenantId: string,
): Promise<KnowledgeDTO> {
  const source = await prisma.riskIssue.findFirst({
    where: { id: issueId, deletedAt: null, tenantId },
    select: { id: true, type: true, visibility: true },
  });
  if (!source) throw new Error('NOT_FOUND');
  if (source.type !== 'issue') throw new Error('INVALID_SOURCE_TYPE');
  if (source.visibility !== 'public') throw new Error('SOURCE_NOT_PUBLIC');

  const knowledge = await createKnowledge(input, userId, tenantId);

  await prisma.issueKnowledgePromotion.create({
    data: { issueId, knowledgeId: knowledge.id, createdBy: userId },
  });

  return knowledge;
}

/**
 * 指定リスクから昇華された課題一覧 (リスク詳細の「昇華済み」バッジ/セクション用)。
 * 課題が論理削除済み、または他テナントの場合は除外する。
 */
export async function getPromotedIssues(
  riskId: string,
  tenantId: string,
): Promise<PromotedAssetSummary[]> {
  const rows = await prisma.riskIssuePromotion.findMany({
    where: { riskId, issue: { tenantId, deletedAt: null } },
    include: { issue: { select: { id: true, title: true, visibility: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => ({
    id: r.issue.id,
    title: r.issue.title,
    visibility: r.issue.visibility,
    promotedAt: r.createdAt.toISOString(),
  }));
}

/**
 * 指定課題の昇華元リスク一覧 (課題詳細の「元リスク」セクション用)。
 */
export async function getSourceRisks(
  issueId: string,
  tenantId: string,
): Promise<PromotedAssetSummary[]> {
  const rows = await prisma.riskIssuePromotion.findMany({
    where: { issueId, risk: { tenantId, deletedAt: null } },
    include: { risk: { select: { id: true, title: true, visibility: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => ({
    id: r.risk.id,
    title: r.risk.title,
    visibility: r.risk.visibility,
    promotedAt: r.createdAt.toISOString(),
  }));
}

/**
 * 指定課題から昇華されたナレッジ一覧 (課題詳細の「昇華済み」バッジ/セクション用)。
 */
export async function getPromotedKnowledge(
  issueId: string,
  tenantId: string,
): Promise<PromotedAssetSummary[]> {
  const rows = await prisma.issueKnowledgePromotion.findMany({
    where: { issueId, knowledge: { tenantId, deletedAt: null } },
    include: { knowledge: { select: { id: true, title: true, visibility: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => ({
    id: r.knowledge.id,
    title: r.knowledge.title,
    visibility: r.knowledge.visibility,
    promotedAt: r.createdAt.toISOString(),
  }));
}

/**
 * 指定ナレッジの昇華元課題一覧 (ナレッジ詳細の「元課題」セクション用)。
 */
export async function getSourceIssues(
  knowledgeId: string,
  tenantId: string,
): Promise<PromotedAssetSummary[]> {
  const rows = await prisma.issueKnowledgePromotion.findMany({
    where: { knowledgeId, issue: { tenantId, deletedAt: null } },
    include: { issue: { select: { id: true, title: true, visibility: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => ({
    id: r.issue.id,
    title: r.issue.title,
    visibility: r.issue.visibility,
    promotedAt: r.createdAt.toISOString(),
  }));
}

/**
 * Sample data curation service (feat/starter-data-import / 2026-06-05)
 *
 * super_admin が「スターターデータの取込元」である管理テナント (MANAGEMENT_TENANT_ID) の
 * Project / Knowledge について `isSampleData` フラグを画面から付け外しするための service。
 *
 * これにより、画面から:
 *   - 既存サンプルの編集 (通常の編集画面、super_admin は isSampleData=true を閲覧可)
 *   - 新規に作った Project/Knowledge を「サンプルにする」(= 取込対象に追加)
 *   - 既存サンプルを「サンプルから外す」(= 取込対象から除外)
 * が完結し、変更は以後の各テナントのスターターデータ取込にそのまま反映される。
 *
 * 重要 (severity-1 防御):
 *   - 更新は **MANAGEMENT_TENANT_ID の行に限定** する (updateMany の where に tenant_id を含める)。
 *     他テナントの実データを誤って isSampleData=true にすると全テナントの取込対象に漏洩するため、
 *     管理テナント以外は一切更新できないようにする。
 *   - 認可 (super_admin 限定) は API route 側で isSuperAdmin により担保する。
 */

import { prisma } from '@/lib/db';
import { MANAGEMENT_TENANT_ID } from '@/lib/tenant';

export type SeedCandidateType = 'project' | 'knowledge';

export type SeedCandidate = {
  id: string;
  type: SeedCandidateType;
  /** project.name または knowledge.title */
  title: string;
  isSampleData: boolean;
};

/**
 * 管理テナントの Project / Knowledge を一覧する (isSampleData の現在値付き)。
 * super_admin がどれをサンプル (= 取込対象) にしているかを把握・切替するための一覧。
 */
export async function listManagementSeedCandidates(): Promise<SeedCandidate[]> {
  const [projects, knowledge] = await Promise.all([
    prisma.project.findMany({
      where: { tenantId: MANAGEMENT_TENANT_ID, deletedAt: null },
      select: { id: true, name: true, isSampleData: true },
      orderBy: { name: 'asc' },
    }),
    prisma.knowledge.findMany({
      where: { tenantId: MANAGEMENT_TENANT_ID, deletedAt: null },
      select: { id: true, title: true, isSampleData: true },
      orderBy: { title: 'asc' },
    }),
  ]);
  return [
    ...projects.map((p) => ({
      id: p.id,
      type: 'project' as const,
      title: p.name,
      isSampleData: p.isSampleData,
    })),
    ...knowledge.map((k) => ({
      id: k.id,
      type: 'knowledge' as const,
      title: k.title,
      isSampleData: k.isSampleData,
    })),
  ];
}

export type SetSampleFlagResult = { ok: true } | { ok: false; error: 'NOT_FOUND' };

/**
 * 管理テナントの Project / Knowledge の isSampleData を切替える。
 * MANAGEMENT_TENANT_ID 以外の行は updateMany の where で除外されるため count=0 (= NOT_FOUND) になる。
 */
export async function setManagementSampleFlag(args: {
  entityType: SeedCandidateType;
  entityId: string;
  isSampleData: boolean;
}): Promise<SetSampleFlagResult> {
  const { entityType, entityId, isSampleData } = args;

  if (entityType === 'project') {
    const r = await prisma.project.updateMany({
      where: { id: entityId, tenantId: MANAGEMENT_TENANT_ID, deletedAt: null },
      data: { isSampleData },
    });
    return r.count > 0 ? { ok: true } : { ok: false, error: 'NOT_FOUND' };
  }

  const r = await prisma.knowledge.updateMany({
    where: { id: entityId, tenantId: MANAGEMENT_TENANT_ID, deletedAt: null },
    data: { isSampleData },
  });
  return r.count > 0 ? { ok: true } : { ok: false, error: 'NOT_FOUND' };
}

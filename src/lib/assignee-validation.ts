import { prisma } from '@/lib/db';

/**
 * feat/asset-assignee-expansion (2026-05-26) severity-1 防御:
 *   担当者 (assigneeId) として指定された User が、操作元と同テナントに属し、かつ soft-delete
 *   されていないことを検証する。
 *
 * 攻撃シナリオ (防御対象):
 *   - テナント A のユーザ a1 が、リスク PATCH 等で `{ assigneeId: '<テナント B のユーザ b1 の id>' }` を送信
 *   - validator は UUID 形式のみチェックするので透過
 *   - service の where に tenantId フィルタはあるが、これは「対象 entity が同テナントか」の検証で、
 *     assignee user の tenantId は検証していない
 *   - 結果として DB に「他テナントの user.id」が assigneeId として保存され得る
 *
 * 漏洩リスク:
 *   - getRisk / listRisks 等で assignee.name を resolve しようとする
 *     → prisma.user.findMany は cross-tenant lookup を許容 (氏名解決は意図的越境)
 *     → UI に他テナントのユーザ氏名が表示される (severity-1 情報漏洩)
 *
 * soft-delete user 防御 (4 巡目検証で追加, KDD §5.X+157):
 *   - 退職等で soft-delete (deletedAt セット) された User を担当者指定すると、その user は
 *     ログイン不可だが assigneeId に残り続け、UI に「削除済ユーザ」が担当者として表示される
 *   - 業務上 dead-end (担当者がアクセスできない) になるため、service 層で reject する
 *
 * 仕様:
 *   - assigneeId が undefined (= 未指定): 何もしない (= 更新対象外)
 *   - assigneeId が null (= 担当解除): 何もしない (= 検証不要、常に許容)
 *   - assigneeId が UUID 文字列: テナント + soft-delete 検証を実施
 *     - DB で user.tenantId / deletedAt を取得 (findFirst で deletedAt フィルタ)
 *     - 同テナント かつ deletedAt=null でなければ ASSIGNEE_TENANT_MISMATCH を throw
 *     - User が存在しない場合も同 throw (= 越境試行と同等の不正パターン)
 *
 * 使用箇所:
 *   - src/services/risk.service.ts (createRisk / updateRisk)
 *   - src/services/knowledge.service.ts (createKnowledge / updateKnowledge)
 *   - src/services/retrospective.service.ts (createRetrospective / updateRetrospective)
 *   - src/services/memo.service.ts (createMemo / updateMemo)
 *
 * @throws {Error} 'ASSIGNEE_TENANT_MISMATCH' — assigneeId が他テナント / 存在しない / soft-delete 済 user
 */
export async function assertAssigneeTenant(
  assigneeId: string | null | undefined,
  expectedTenantId: string,
): Promise<void> {
  if (assigneeId === undefined) return;
  if (assigneeId === null) return;
  // 4 巡目検証 (KDD §5.X+157): findFirst + deletedAt=null フィルタで soft-delete user も reject
  const user = await prisma.user.findFirst({
    where: { id: assigneeId, deletedAt: null },
    select: { tenantId: true },
  });
  if (!user || user.tenantId !== expectedTenantId) {
    throw new Error('ASSIGNEE_TENANT_MISMATCH');
  }
}

/**
 * 顧客管理サービス (PR #111)。
 *
 * 方針:
 *   - 顧客 (Customer) はプロジェクト (Project) の 1 : N の親エンティティ
 *   - システム管理者 (systemRole='admin') のみ CRUD 可能 (認可は呼び出し元 API route で実施)
 *   - 物理削除方針 (deleted_at 列を持たない、将来論理削除に移行する可能性あり)
 *   - 削除時、紐付く **active Project (deletedAt IS NULL)** が存在する場合は 409 相当でエラー
 *   - カスケード削除 (紐付く Project も削除) は PR #111-2 で `deleteCustomerCascade` として実装予定
 *
 * 関連:
 *   - prisma/schema.prisma Customer モデル
 *   - src/lib/validators/customer.ts
 *   - 設計 (PR #111-2 で docs/developer/DESIGN.md に追記予定)
 */

import { prisma } from '@/lib/db';
import type { CreateCustomerInput, UpdateCustomerInput } from '@/lib/validators/customer';
import { deleteProjectCascade } from './project.service';

export type CustomerDTO = {
  id: string;
  name: string;
  department: string | null;
  contactPerson: string | null;
  contactEmail: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  /** 紐付く active Project 件数 (deletedAt IS NULL のみカウント、削除可否判定 UI で使う) */
  activeProjectCount: number;
};

function toDTO(c: {
  id: string;
  name: string;
  department: string | null;
  contactPerson: string | null;
  contactEmail: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { projects: number };
}): CustomerDTO {
  return {
    id: c.id,
    name: c.name,
    department: c.department,
    contactPerson: c.contactPerson,
    contactEmail: c.contactEmail,
    notes: c.notes,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    activeProjectCount: c._count?.projects ?? 0,
  };
}

/**
 * 顧客一覧取得。
 * 紐付く active Project 件数も同時に取得 (UI の「削除ボタン活性/非活性」判定に使う)。
 *
 * 2026-05-09 feedback: severity-1 テナント越境防止。viewerTenantId を必須化し、
 *   自テナント内の顧客のみ返す。旧仕様では全テナントの顧客 (氏名 / 連絡先 / メール) が
 *   他テナント admin に漏洩する重大バグだった。
 */
export async function listCustomers(viewerTenantId: string): Promise<CustomerDTO[]> {
  const rows = await prisma.customer.findMany({
    where: { tenantId: viewerTenantId },
    include: {
      _count: {
        select: {
          projects: {
            where: { deletedAt: null },
          },
        },
      },
    },
    orderBy: { name: 'asc' },
  });
  return rows.map(toDTO);
}

/**
 * 単一顧客取得 (存在しない場合は null)。
 *
 * 2026-05-09 feedback: viewerTenantId を必須化し、id バレで他テナント顧客が漏れる経路を遮断。
 */
export async function getCustomer(
  customerId: string,
  viewerTenantId: string,
): Promise<CustomerDTO | null> {
  const row = await prisma.customer.findFirst({
    where: { id: customerId, tenantId: viewerTenantId },
    include: {
      _count: {
        select: {
          projects: {
            where: { deletedAt: null },
          },
        },
      },
    },
  });
  return row ? toDTO(row) : null;
}

export async function createCustomer(
  input: CreateCustomerInput,
  userId: string,
  tenantId: string,
): Promise<CustomerDTO> {
  // 2026-05-09 feedback: tenantId を data に明示し、schema DB DEFAULT への暗黙依存を解消。
  const created = await prisma.customer.create({
    data: {
      tenantId,
      name: input.name,
      department: input.department || null,
      contactPerson: input.contactPerson || null,
      contactEmail: input.contactEmail || null,
      notes: input.notes || null,
      createdBy: userId,
      updatedBy: userId,
    },
    include: {
      _count: {
        select: {
          projects: {
            where: { deletedAt: null },
          },
        },
      },
    },
  });
  return toDTO(created);
}

export async function updateCustomer(
  customerId: string,
  input: UpdateCustomerInput,
  userId: string,
  viewerTenantId: string,
): Promise<CustomerDTO | null> {
  // 2026-05-09 feedback: 越境編集を遮断するため where に tenantId を含める。
  const existing = await prisma.customer.findFirst({
    where: { id: customerId, tenantId: viewerTenantId },
    select: { id: true },
  });
  if (!existing) return null;

  const updated = await prisma.customer.update({
    where: { id: customerId },
    data: {
      name: input.name,
      department: input.department !== undefined ? (input.department || null) : undefined,
      contactPerson:
        input.contactPerson !== undefined ? (input.contactPerson || null) : undefined,
      contactEmail:
        input.contactEmail !== undefined ? (input.contactEmail || null) : undefined,
      notes: input.notes !== undefined ? (input.notes || null) : undefined,
      updatedBy: userId,
    },
    include: {
      _count: {
        select: {
          projects: {
            where: { deletedAt: null },
          },
        },
      },
    },
  });
  return toDTO(updated);
}

/**
 * 顧客削除 (物理削除)。
 *
 * **本 PR (PR #111-1) では、active Project が 1 件でも紐付く場合は削除不可** とする。
 * カスケード削除 (Project も一括削除) は PR #111-2 で `deleteCustomerCascade` を別途実装。
 *
 * 戻り値:
 *   - `{ ok: true }` : 削除成功
 *   - `{ ok: false, reason: 'not_found' }` : 顧客が存在しない
 *   - `{ ok: false, reason: 'has_active_projects', activeProjectCount: N }` : active Project が残存
 */
export async function deleteCustomer(
  customerId: string,
  viewerTenantId: string,
): Promise<
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'has_active_projects'; activeProjectCount: number }
> {
  // 2026-05-09 feedback: 越境削除を遮断するため where に tenantId を含める。
  const existing = await prisma.customer.findFirst({
    where: { id: customerId, tenantId: viewerTenantId },
    include: {
      _count: {
        select: {
          projects: {
            where: { deletedAt: null },
          },
        },
      },
    },
  });
  if (!existing) {
    return { ok: false, reason: 'not_found' };
  }

  const activeCount = existing._count.projects;
  if (activeCount > 0) {
    return { ok: false, reason: 'has_active_projects', activeProjectCount: activeCount };
  }

  // PR fix/visibility-auth-matrix (2026-05-01): Customer は admin only entity だが
  //   削除前に紐づく Comment を soft-delete してから物理削除する (§5.51)。
  //   Customer 本体は物理削除なので、コメント側は将来的に物理削除を検討する余地あり。
  //   現状は他 entity と挙動を揃えて soft-delete に統一する。
  await prisma.$transaction([
    prisma.comment.updateMany({
      where: { entityType: 'customer', entityId: customerId, deletedAt: null },
      data: { deletedAt: new Date() },
    }),
    // 物理削除。論理削除済み Project の customer_id は FK ON DELETE SET NULL で自動 null 化。
    prisma.customer.delete({ where: { id: customerId } }),
  ]);
  return { ok: true };
}

/**
 * 顧客をカスケード削除する (PR #111-2)。
 *
 * 紐付く active Project (deletedAt = null) を全件 `deleteProjectCascade` で物理削除し、
 * 最後に Customer 本体を物理削除する。論理削除済 Project は `ON DELETE SET NULL` により
 * customer_id が null 化されるだけで本体は残る (監査・振り返りのため)。
 *
 * 細粒度カスケードフラグ (options) は各 Project の `deleteProjectCascade` にそのまま渡す。
 * - cascadeRisks / cascadeIssues / cascadeRetros / cascadeKnowledge は
 *   確認ダイアログから渡される。
 *
 * 戻り値は削除された件数の集約 (画面でトースト表示に使う)。
 */
export async function deleteCustomerCascade(
  customerId: string,
  viewerTenantId: string,
  options: {
    cascadeRisks?: boolean;
    cascadeIssues?: boolean;
    cascadeRetros?: boolean;
    cascadeKnowledge?: boolean;
  } = {},
): Promise<
  | { ok: false; reason: 'not_found' }
  | {
      ok: true;
      projectsDeleted: number;
      risksDeleted: number;
      issuesDeleted: number;
      retrospectivesDeleted: number;
      knowledgeDeleted: number;
      knowledgeUnlinked: number;
      attachmentsDeleted: number;
    }
> {
  // 2026-05-09 feedback: 越境カスケード削除を遮断するため where に tenantId を必ず含める。
  const existing = await prisma.customer.findFirst({
    where: { id: customerId, tenantId: viewerTenantId },
    select: { id: true },
  });
  if (!existing) return { ok: false, reason: 'not_found' };

  // active Project のみ対象 (論理削除済 Project は FK null 化のみで残す)。
  // tenantId フィルタも併記して不慮の越境カスケードを二重防御。
  const activeProjects = await prisma.project.findMany({
    where: { customerId, tenantId: viewerTenantId, deletedAt: null },
    select: { id: true },
  });

  const totals = {
    projectsDeleted: 0,
    risksDeleted: 0,
    issuesDeleted: 0,
    retrospectivesDeleted: 0,
    knowledgeDeleted: 0,
    knowledgeUnlinked: 0,
    attachmentsDeleted: 0,
  };

  for (const p of activeProjects) {
    const r = await deleteProjectCascade(p.id, viewerTenantId, options);
    totals.projectsDeleted += 1;
    totals.risksDeleted += r.risks;
    totals.issuesDeleted += r.issues;
    totals.retrospectivesDeleted += r.retrospectives;
    totals.knowledgeDeleted += r.knowledgeDeleted;
    totals.knowledgeUnlinked += r.knowledgeUnlinked;
    totals.attachmentsDeleted += r.attachmentsDeleted;
  }

  await prisma.customer.delete({ where: { id: customerId } });
  return { ok: true, ...totals };
}

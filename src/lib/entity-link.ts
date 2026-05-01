/**
 * Entity 別の deep link 生成 (PR feat/notification-edit-dialog、通知の link 用)。
 *
 * Notification.link は UI 側でクリックされた際に該当 entity の編集 dialog を
 * 直接 auto-open するための URL。受信者が project member 以外でも開ける必要があるため、
 * 「全○○」(visibility='public' のみ閲覧可) の cross-list ページに遷移し、各画面で
 * `useSearchParams()` を読み取って該当行の dialog を開く。
 *
 * 各 entity の URL 形式:
 *   - risk          : /risks?riskId={entityId}                 (全リスク画面で auto-open)
 *   - issue         : /issues?riskId={entityId}                (全課題画面で auto-open)
 *   - retrospective : /retrospectives?retroId={entityId}       (全振り返り画面で auto-open)
 *   - knowledge     : /knowledge?knowledgeId={entityId}        (全ナレッジ画面で auto-open)
 *   - task          : /projects/{projectId}/tasks?taskId={id}  (mention は ProjectMember 限定なので個別画面で OK)
 *   - stakeholder   : /projects/{projectId}?tab=stakeholders&stakeholderId={id}
 *                       (project 詳細画面の tab 切替 + dialog auto-open。
 *                        専用 page.tsx を作らず project-detail-client が tab 切替で対応)
 *   - customer      : /customers/{entityId}                    (mention は admin 限定なので admin 画面で OK)
 *
 * entity が削除済の場合は cross-list ページのみ (query param なし) を返す。
 *
 * 設計判断 (2026-05-01):
 *   旧実装は全 entity を /projects/{pid}/... に遷移させていたが、project member 以外が
 *   メンションを受けて link をクリックすると notFound になる問題があった。リスク/課題/振り返り/
 *   ナレッジは cross-list 画面で visibility='public' なら閲覧可なので、これらは cross-list に
 *   寄せて「メンション受信者が必ず開ける」状態を担保する。task/stakeholder/customer は
 *   mention 認可自体を project member / PM/TL / admin に絞ることで矛盾を解消。
 */

import { prisma } from '@/lib/db';
import type { CommentEntityType } from '@/lib/validators/comment';

/**
 * Notification.link を組み立てる。entity 削除済 / 解決不能ならフォールバック URL を返す。
 */
export async function buildEntityCommentLink(
  entityType: CommentEntityType,
  entityId: string,
): Promise<string> {
  switch (entityType) {
    case 'task': {
      const t = await prisma.task.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { projectId: true },
      });
      return t ? `/projects/${t.projectId}/tasks?taskId=${entityId}` : '/my-tasks';
    }
    case 'issue':
    case 'risk': {
      // mention は認証済全員が対象になり得るため、cross-list に遷移して全○○ で auto-open する。
      const r = await prisma.riskIssue.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { type: true },
      });
      if (!r) return entityType === 'issue' ? '/issues' : '/risks';
      const seg = entityType === 'issue' ? 'issues' : 'risks';
      return `/${seg}?riskId=${entityId}`;
    }
    case 'retrospective': {
      const retro = await prisma.retrospective.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { id: true },
      });
      return retro ? `/retrospectives?retroId=${entityId}` : '/retrospectives';
    }
    case 'knowledge': {
      const k = await prisma.knowledge.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { id: true },
      });
      return k ? `/knowledge?knowledgeId=${entityId}` : '/knowledge';
    }
    case 'stakeholder': {
      // mention は PM/TL 限定 (route 層で enforce)。
      // /projects/{id}/stakeholders/page.tsx は存在しない (stakeholder UI はプロジェクト詳細画面の
      // タブとして実装) ため、`?tab=stakeholders&stakeholderId=...` で tab 切替 + dialog auto-open
      // を project-detail-client で行う (PR feat/notification-deep-link-completion / 2026-05-01)。
      const s = await prisma.stakeholder.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { projectId: true },
      });
      return s
        ? `/projects/${s.projectId}?tab=stakeholders&stakeholderId=${entityId}`
        : '/projects';
    }
    case 'customer': {
      // mention は admin 限定 (route 層で enforce)、admin only ページに直接遷移。
      return `/customers/${entityId}`;
    }
  }
}

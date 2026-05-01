/**
 * Entity 別の deep link 生成 (PR feat/comment-mentions、通知の link 用)。
 *
 * Notification.link は UI 側でクリックされた際に該当 entity の編集 dialog を
 * 直接開くための URL。entity のプロジェクト所属を解決して project-scoped path に組み立てる。
 *
 * 各 entity の URL 形式:
 *   - task          : /projects/{projectId}/tasks?taskId={entityId}
 *   - issue         : /projects/{projectId}/issues?riskId={entityId}
 *   - risk          : /projects/{projectId}/risks?riskId={entityId}
 *   - retrospective : /projects/{projectId}/retrospectives?retroId={entityId}
 *   - knowledge     : /projects/{projectId}/knowledge?knowledgeId={entityId}
 *   - stakeholder   : /projects/{projectId}/stakeholders?stakeholderId={entityId}
 *   - customer      : /customers/{entityId}
 *
 * project が解決できない場合 (entity が削除済み or N:M 紐付けゼロ) は cross-list ページ
 * (/risks, /issues 等) へのフォールバックを返す。
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
      const r = await prisma.riskIssue.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { projectId: true, type: true },
      });
      if (!r) return entityType === 'issue' ? '/issues' : '/risks';
      const seg = entityType === 'issue' ? 'issues' : 'risks';
      return `/projects/${r.projectId}/${seg}?riskId=${entityId}`;
    }
    case 'retrospective': {
      const retro = await prisma.retrospective.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { projectId: true },
      });
      return retro
        ? `/projects/${retro.projectId}/retrospectives?retroId=${entityId}`
        : '/retrospectives';
    }
    case 'knowledge': {
      const k = await prisma.knowledge.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { knowledgeProjects: { select: { projectId: true }, take: 1 } },
      });
      const pid = k?.knowledgeProjects[0]?.projectId;
      return pid ? `/projects/${pid}/knowledge?knowledgeId=${entityId}` : '/knowledge';
    }
    case 'stakeholder': {
      const s = await prisma.stakeholder.findFirst({
        where: { id: entityId, deletedAt: null },
        select: { projectId: true },
      });
      return s
        ? `/projects/${s.projectId}/stakeholders?stakeholderId=${entityId}`
        : '/projects';
    }
    case 'customer': {
      // customer は admin のみ、/customers/{id} に直接遷移
      return `/customers/${entityId}`;
    }
  }
}

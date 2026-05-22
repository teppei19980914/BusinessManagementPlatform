import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { listAllKnowledgeForViewer } from '@/services/knowledge.service';
import { KnowledgeClient } from './knowledge-client';

/**
 * 全ナレッジ画面 (PR #55 Req 4):
 *   listKnowledge (visibility ベース旧フロー) → listAllKnowledgeForViewer に切替。
 *   プロジェクト紐付け情報・更新者氏名を含む AllKnowledgeDTO を渡す。
 */
// PR #425 (2026-05-22) KDD §5.X+102: URL ?keyword=&type= 永続化
type SearchParams = Promise<{ keyword?: string; type?: string }>;

export default async function KnowledgePage({ searchParams }: { searchParams: SearchParams }) {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const sp = await searchParams;
  const knowledges = await listAllKnowledgeForViewer(
    session.user.id,
    session.user.systemRole,
    session.user.tenantId,
  );

  return (
    <KnowledgeClient
      initialKnowledge={knowledges}
      systemRole={session.user.systemRole}
      initialKeyword={sp.keyword ?? ''}
      initialTypeFilter={sp.type ?? ''}
    />
  );
}

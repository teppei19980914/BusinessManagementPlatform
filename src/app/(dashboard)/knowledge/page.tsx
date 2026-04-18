import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listAllKnowledgeForViewer } from '@/services/knowledge.service';
import { KnowledgeClient } from './knowledge-client';

/**
 * 全ナレッジ画面 (PR #55 Req 4):
 *   listKnowledge (visibility ベース旧フロー) → listAllKnowledgeForViewer に切替。
 *   プロジェクト紐付け情報・更新者氏名を含む AllKnowledgeDTO を渡す。
 */
export default async function KnowledgePage() {
  const session = await auth();
  if (!session) redirect('/login');

  const knowledges = await listAllKnowledgeForViewer(
    session.user.id,
    session.user.systemRole,
  );

  return (
    <KnowledgeClient
      initialKnowledge={knowledges}
      systemRole={session.user.systemRole}
    />
  );
}

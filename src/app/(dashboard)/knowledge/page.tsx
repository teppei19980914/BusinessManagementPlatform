import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listKnowledge } from '@/services/knowledge.service';
import { KnowledgeClient } from './knowledge-client';

export default async function KnowledgePage() {
  const session = await auth();
  if (!session) redirect('/login');

  const result = await listKnowledge(
    { page: 1, limit: 20 },
    session.user.id,
    session.user.systemRole,
  );

  return (
    <KnowledgeClient
      initialKnowledge={result.data}
      initialTotal={result.total}
      systemRole={session.user.systemRole}
    />
  );
}

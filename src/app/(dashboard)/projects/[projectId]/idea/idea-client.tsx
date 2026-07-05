'use client';

/**
 * アイデア出しタブのルートコンポーネント (v1.5.0)
 *
 * サブタブで 4 機能を切り替える:
 *   - ライブ投票 (live)
 *   - 事前投票 (pre)
 *   - ホワイトボード (whiteboard)
 *   - 匿名FAQ (qa)
 */

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

function Loading() {
  return <div className="py-8 text-center text-sm text-muted-foreground">読み込み中...</div>;
}
const LOADING = <Loading />;

const IdeaVotingClient = dynamic(
  () => import('./idea-voting-client').then((m) => m.IdeaVotingClient),
  { ssr: false, loading: () => LOADING },
);

const IdeaWhiteboardClient = dynamic(
  () => import('./idea-whiteboard-client').then((m) => m.IdeaWhiteboardClient),
  { ssr: false, loading: () => LOADING },
);

const IdeaQaClient = dynamic(
  () => import('./idea-qa-client').then((m) => m.IdeaQaClient),
  { ssr: false, loading: () => LOADING },
);

type Props = {
  projectId: string;
  /** member / pm_tl / admin で投票・付箋・Q&A 投稿可 (viewer は閲覧のみ) */
  canSubmit: boolean;
  /** member 以上でセッション作成・クローズ・削除可 */
  canManage: boolean;
};

export function IdeaClient({ projectId, canSubmit, canManage }: Props) {
  const [subTab, setSubTab] = useState<'live' | 'pre' | 'whiteboard' | 'qa'>('live');

  return (
    <div className="space-y-4">
      <Tabs value={subTab} onValueChange={(v) => setSubTab(v as typeof subTab)}>
        <TabsList>
          <TabsTrigger value="live">ライブ投票</TabsTrigger>
          <TabsTrigger value="pre">事前投票</TabsTrigger>
          <TabsTrigger value="whiteboard">ホワイトボード</TabsTrigger>
          <TabsTrigger value="qa">匿名FAQ</TabsTrigger>
        </TabsList>

        <TabsContent value="live" className="mt-4">
          <IdeaVotingClient
            projectId={projectId}
            kind="live"
            canSubmit={canSubmit}
            canManage={canManage}
          />
        </TabsContent>

        <TabsContent value="pre" className="mt-4">
          <IdeaVotingClient
            projectId={projectId}
            kind="pre"
            canSubmit={canSubmit}
            canManage={canManage}
          />
        </TabsContent>

        <TabsContent value="whiteboard" className="mt-4">
          <IdeaWhiteboardClient
            projectId={projectId}
            canSubmit={canSubmit}
            canManage={canManage}
          />
        </TabsContent>

        <TabsContent value="qa" className="mt-4">
          <IdeaQaClient
            projectId={projectId}
            canSubmit={canSubmit}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

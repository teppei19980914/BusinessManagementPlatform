'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { PROJECT_STATUSES, DEV_METHODS } from '@/types';
import type { ProjectDTO } from '@/services/project.service';
import type { EstimateDTO } from '@/services/estimate.service';
import type { TaskDTO } from '@/services/task.service';
import type { RiskDTO } from '@/services/risk.service';
import type { RetroDTO } from '@/services/retrospective.service';
import type { MemberDTO } from '@/services/member.service';
import type { KnowledgeDTO } from '@/services/knowledge.service';
import { EstimatesClient } from './estimates/estimates-client';
import { TasksClient } from './tasks/tasks-client';
import { GanttClient } from './gantt/gantt-client';
import { RisksClient } from './risks/risks-client';
import { RetrospectivesClient } from './retrospectives/retrospectives-client';

type Props = {
  project: ProjectDTO;
  projectRole: string | null;
  systemRole: string;
  userId: string;
  estimates: EstimateDTO[];
  tasks: TaskDTO[];
  tasksFlat: TaskDTO[];
  risks: RiskDTO[];
  retros: RetroDTO[];
  members: MemberDTO[];
  knowledges: KnowledgeDTO[];
  canEdit: boolean;
  canCreate: boolean;
};

const NEXT_STATUSES: Record<string, string[]> = {
  planning: ['estimating'],
  estimating: ['scheduling'],
  scheduling: ['executing'],
  executing: ['completed'],
  completed: ['retrospected'],
  retrospected: ['closed'],
  closed: [],
};

export function ProjectDetailClient({
  project, projectRole, systemRole, userId,
  estimates, tasks, tasksFlat, risks, retros, members, knowledges,
  canEdit, canCreate,
}: Props) {
  const router = useRouter();
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  const canChangeStatus = systemRole === 'admin' || projectRole === 'pm_tl';
  const nextStatuses = NEXT_STATUSES[project.status] || [];

  async function handleStatusChange(newStatus: string | null) {
    if (!newStatus) return;
    setIsChangingStatus(true);
    const res = await fetch(`/api/projects/${project.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    setIsChangingStatus(false);
    if (res.ok) router.refresh();
  }

  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-semibold">{project.name}</h2>
            <Badge>
              {PROJECT_STATUSES[project.status as keyof typeof PROJECT_STATUSES] || project.status}
            </Badge>
          </div>
          <p className="mt-1 text-gray-600">{project.customerName}</p>
        </div>
        <div className="flex items-center gap-2">
          {canChangeStatus && nextStatuses.length > 0 && (
            <Select onValueChange={handleStatusChange} disabled={isChangingStatus}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="状態変更..." />
              </SelectTrigger>
              <SelectContent>
                {nextStatuses.map((s) => (
                  <SelectItem key={s} value={s}>
                    → {PROJECT_STATUSES[s as keyof typeof PROJECT_STATUSES]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button variant="outline" onClick={() => router.push('/projects')}>
            一覧に戻る
          </Button>
        </div>
      </div>

      {/* タブ - 全機能をタブ内に直接埋め込み */}
      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">概要</TabsTrigger>
          {canEdit && <TabsTrigger value="estimates">見積もり</TabsTrigger>}
          <TabsTrigger value="tasks">WBS/タスク</TabsTrigger>
          <TabsTrigger value="gantt">ガント</TabsTrigger>
          <TabsTrigger value="risks">リスク/課題</TabsTrigger>
          <TabsTrigger value="retrospectives">振り返り</TabsTrigger>
          <TabsTrigger value="knowledge">ナレッジ</TabsTrigger>
        </TabsList>

        {/* 概要タブ */}
        <TabsContent value="overview" className="mt-4 space-y-6">
          <div className="grid gap-6 md:grid-cols-2">
            <div className="rounded-lg border p-4">
              <h3 className="mb-2 font-semibold">基本情報</h3>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-gray-500">開発方式</dt>
                  <dd>{DEV_METHODS[project.devMethod as keyof typeof DEV_METHODS] || project.devMethod}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">開始予定日</dt>
                  <dd>{project.plannedStartDate}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">終了予定日</dt>
                  <dd>{project.plannedEndDate}</dd>
                </div>
              </dl>
            </div>
            <div className="rounded-lg border p-4">
              <h3 className="mb-2 font-semibold">目的</h3>
              <p className="whitespace-pre-wrap text-sm text-gray-700">{project.purpose}</p>
            </div>
            <div className="rounded-lg border p-4">
              <h3 className="mb-2 font-semibold">背景</h3>
              <p className="whitespace-pre-wrap text-sm text-gray-700">{project.background}</p>
            </div>
            <div className="rounded-lg border p-4">
              <h3 className="mb-2 font-semibold">スコープ</h3>
              <p className="whitespace-pre-wrap text-sm text-gray-700">{project.scope}</p>
              {project.outOfScope && (
                <>
                  <h3 className="mb-2 mt-4 font-semibold">スコープ外</h3>
                  <p className="whitespace-pre-wrap text-sm text-gray-700">{project.outOfScope}</p>
                </>
              )}
            </div>
          </div>
          {project.notes && (
            <div className="rounded-lg border p-4">
              <h3 className="mb-2 font-semibold">備考</h3>
              <p className="whitespace-pre-wrap text-sm text-gray-700">{project.notes}</p>
            </div>
          )}
        </TabsContent>

        {/* 見積もりタブ */}
        <TabsContent value="estimates" className="mt-4">
          <EstimatesClient projectId={project.id} estimates={estimates} canEdit={canEdit} />
        </TabsContent>

        {/* WBS/タスクタブ */}
        <TabsContent value="tasks" className="mt-4">
          <TasksClient
            projectId={project.id}
            tasks={tasks}
            members={members}
            projectRole={projectRole}
            systemRole={systemRole}
            userId={userId}
          />
        </TabsContent>

        {/* ガントチャートタブ */}
        <TabsContent value="gantt" className="mt-4">
          <GanttClient projectId={project.id} tasks={tasksFlat} />
        </TabsContent>

        {/* リスク/課題タブ */}
        <TabsContent value="risks" className="mt-4">
          <RisksClient
            projectId={project.id}
            risks={risks}
            members={members}
            canEdit={canEdit}
            canCreate={canCreate}
            systemRole={systemRole}
          />
        </TabsContent>

        {/* 振り返りタブ */}
        <TabsContent value="retrospectives" className="mt-4">
          <RetrospectivesClient
            projectId={project.id}
            retros={retros}
            canEdit={canEdit}
            canComment={canCreate}
          />
        </TabsContent>

        {/* ナレッジタブ */}
        <TabsContent value="knowledge" className="mt-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">関連ナレッジ</h3>
              <a href="/knowledge" className="text-sm text-blue-600 hover:underline">
                ナレッジ横断検索 →
              </a>
            </div>
            {knowledges.length === 0 ? (
              <p className="py-4 text-center text-gray-500">ナレッジがありません</p>
            ) : (
              <div className="space-y-2">
                {knowledges.slice(0, 10).map((k) => (
                  <div key={k.id} className="rounded border p-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{k.title}</span>
                      <Badge variant="secondary" className="text-xs">{k.knowledgeType}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-gray-500 line-clamp-2">{k.content}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PROJECT_STATUSES, DEV_METHODS } from '@/types';
import type { ProjectDTO } from '@/services/project.service';

type Props = {
  project: ProjectDTO;
  projectRole: string | null;
  systemRole: string;
};

// 遷移先の候補（State Machine の定義に基づく）
const NEXT_STATUSES: Record<string, string[]> = {
  planning: ['estimating'],
  estimating: ['scheduling'],
  scheduling: ['executing'],
  executing: ['completed'],
  completed: ['retrospected'],
  retrospected: ['closed'],
  closed: [],
};

export function ProjectDetailClient({ project, projectRole, systemRole }: Props) {
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

    if (res.ok) {
      router.refresh();
    }
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

      {/* タブ */}
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">概要</TabsTrigger>
          <TabsTrigger value="tasks">WBS/タスク</TabsTrigger>
          <TabsTrigger value="knowledge">ナレッジ</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-6">
          <div className="grid gap-6 md:grid-cols-2">
            <div className="rounded-lg border p-4">
              <h3 className="mb-2 font-semibold">基本情報</h3>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-gray-500">開発方式</dt>
                  <dd>
                    {DEV_METHODS[project.devMethod as keyof typeof DEV_METHODS] ||
                      project.devMethod}
                  </dd>
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

        <TabsContent value="tasks" className="mt-4">
          <div className="flex justify-end">
            <a
              href={`/projects/${project.id}/tasks`}
              className="text-sm text-blue-600 hover:underline"
            >
              タスク管理画面を開く →
            </a>
          </div>
          <p className="mt-2 text-sm text-gray-500">
            詳細なタスク管理（作成・編集・進捗更新）はタスク管理画面で行います。
          </p>
        </TabsContent>

        <TabsContent value="knowledge" className="mt-4">
          <p className="text-gray-500">ナレッジ管理はタスク #7 で実装予定です。</p>
        </TabsContent>
      </Tabs>
    </div>
  );
}

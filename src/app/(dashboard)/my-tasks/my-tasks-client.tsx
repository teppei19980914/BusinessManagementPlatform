'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { TASK_STATUSES, PRIORITIES } from '@/types';
import type { TaskDTO } from '@/services/task.service';

type ProjectGroup = {
  projectId: string;
  projectName: string;
  tree: TaskDTO[];
};

type Props = {
  projectGroups: ProjectGroup[];
  /** サーバ側で算出した本日日付 (YYYY-MM-DD)。遅延判定のハイドレーション安全化に使用 */
  today: string;
};

const statusColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  not_started: 'outline',
  in_progress: 'default',
  completed: 'secondary',
  on_hold: 'destructive',
};

/**
 * マイタスクのクライアントコンポーネント (Req 2: PR #57)。
 *
 * 構造:
 *   - プロジェクト毎に折りたたみ可能なセクション (▶ / ▼)
 *   - 各セクション内は WBS 画面と同じ階層ツリー表現
 *     * WP はさらに折りたたみ可能 (子 ACT の表示制御)
 *     * depth に応じてインデント、WP/ACT バッジ
 *     * 担当者フィルタは「自分」で固定済み (filterTreeByAssignee)
 */
export function MyTasksClient({ projectGroups, today }: Props) {
  // プロジェクトセクションの折りたたみ状態 (初期展開)
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const toggleProject = (projectId: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  if (projectGroups.length === 0) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-semibold">マイタスク</h2>
        <p className="py-8 text-center text-gray-500">担当タスクがありません</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">マイタスク</h2>

      {projectGroups.map((pg) => {
        const isProjectCollapsed = collapsedProjects.has(pg.projectId);
        return (
          <div key={pg.projectId} className="rounded-lg border overflow-x-auto">
            {/* プロジェクトセクションヘッダ (クリックで開閉) */}
            <div className="flex items-center gap-2 border-b bg-gray-50 px-3 py-2">
              <button
                type="button"
                onClick={() => toggleProject(pg.projectId)}
                className="flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-gray-200"
                aria-label={isProjectCollapsed ? '展開' : '折りたたみ'}
              >
                <span className={`text-xs transition-transform ${isProjectCollapsed ? '' : 'rotate-90'}`}>▶</span>
              </button>
              <Link
                href={`/projects/${pg.projectId}`}
                className="font-semibold text-blue-600 hover:underline"
              >
                {pg.projectName}
              </Link>
              <span className="text-xs text-gray-500">
                ({countActivities(pg.tree)} 件)
              </span>
            </div>

            {!isProjectCollapsed && (
              <table className="min-w-full text-xs md:text-sm">
                <thead className="bg-white">
                  <tr>
                    <th className="px-1.5 py-1.5 md:px-3 md:py-2 text-left font-medium">名称</th>
                    <th className="px-1.5 py-1.5 md:px-3 md:py-2 text-left font-medium whitespace-nowrap">ステータス</th>
                    <th className="px-1.5 py-1.5 md:px-3 md:py-2 text-left font-medium whitespace-nowrap">進捗&工数</th>
                    <th className="px-1.5 py-1.5 md:px-3 md:py-2 text-left font-medium whitespace-nowrap">予定期間</th>
                    <th className="px-1.5 py-1.5 md:px-3 md:py-2 text-left font-medium whitespace-nowrap">実績期間</th>
                    <th className="px-1.5 py-1.5 md:px-3 md:py-2 text-left font-medium whitespace-nowrap">優先度</th>
                  </tr>
                </thead>
                <tbody>
                  {pg.tree.map((task) => (
                    <TaskRow key={task.id} task={task} depth={0} today={today} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 再帰的なタスク行。WBS 画面の TaskTreeNode と同じ折りたたみ・インデント表現を、
 * read-only の軽量版として実装 (編集 UI は不要)。
 */
function TaskRow({ task, depth, today }: { task: TaskDTO; depth: number; today: string }) {
  const isWP = task.type === 'work_package';
  const hasChildren = task.children && task.children.length > 0;
  const [isCollapsed, setIsCollapsed] = useState(false);

  const plannedRangeText = (() => {
    if (!task.plannedStartDate && !task.plannedEndDate) return '-';
    return `${task.plannedStartDate || '（未）'} 〜 ${task.plannedEndDate || '（未）'}`;
  })();
  const actualRangeText = (() => {
    if (!task.actualStartDate && !task.actualEndDate) return '-';
    return `${task.actualStartDate || '（未）'} 〜 ${task.actualEndDate || '（未）'}`;
  })();
  const effortText = task.plannedEffort > 0 ? `${task.plannedEffort}h` : null;

  // 遅延判定はサーバ提供の today 文字列と YYYY-MM-DD 比較で決定的に行う
  // (new Date() の差で発生する hydration mismatch を回避)。
  const isDelayed = !isWP
    && task.plannedEndDate != null
    && task.status !== 'completed'
    && task.plannedEndDate < today;

  return (
    <>
      <tr className={`border-b hover:bg-gray-50 ${isWP ? 'bg-gray-50/50' : ''} ${isDelayed ? 'bg-red-50' : ''}`}>
        <td
          className="px-1.5 py-1.5 md:px-3 md:py-2"
          style={{ paddingLeft: `${depth * 20 + 8}px` }}
        >
          <div className="flex items-center gap-1.5 md:gap-2">
            {isWP && hasChildren ? (
              <button
                type="button"
                onClick={() => setIsCollapsed(!isCollapsed)}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-200"
              >
                <span className={`text-xs transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>▶</span>
              </button>
            ) : (
              <span className="w-5 shrink-0" />
            )}
            <Badge variant={isWP ? 'default' : 'outline'} className="shrink-0 text-[10px] px-1.5 py-0">
              {isWP ? 'WP' : 'ACT'}
            </Badge>
            <span className={isWP ? 'font-semibold' : 'font-medium'}>{task.name}</span>
            {task.wbsNumber && <span className="text-xs text-gray-400">{task.wbsNumber}</span>}
            {isWP && hasChildren && isCollapsed && (
              <span className="text-xs text-gray-400">({task.children!.length})</span>
            )}
            {isDelayed && <Badge variant="destructive" className="ml-1 text-[10px]">遅延</Badge>}
          </div>
        </td>
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">
          <Badge variant={statusColors[task.status] || 'outline'}>
            {TASK_STATUSES[task.status as keyof typeof TASK_STATUSES] || task.status}
          </Badge>
        </td>
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">
          <div className="flex items-center gap-1.5 md:gap-2">
            <div className="h-2 w-10 md:w-16 rounded-full bg-gray-200">
              <div className="h-2 rounded-full bg-blue-500" style={{ width: `${task.progressRate}%` }} />
            </div>
            <span>{task.progressRate}%</span>
            {effortText && <span className="text-xs text-gray-500">/ {effortText}</span>}
          </div>
        </td>
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">{plannedRangeText}</td>
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">{actualRangeText}</td>
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">
          {task.priority
            ? PRIORITIES[task.priority as keyof typeof PRIORITIES] || task.priority
            : '-'}
        </td>
      </tr>
      {!isCollapsed && task.children?.map((child) => (
        <TaskRow key={child.id} task={child} depth={depth + 1} today={today} />
      ))}
    </>
  );
}

/**
 * ツリー内の ACT 数を数えるヘルパ (プロジェクトセクションのカウント表示用)。
 */
function countActivities(nodes: TaskDTO[]): number {
  let count = 0;
  for (const n of nodes) {
    if (n.type === 'activity') count++;
    if (n.children) count += countActivities(n.children);
  }
  return count;
}

'use client';

import { useCallback, useMemo } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TASK_STATUSES, PRIORITIES } from '@/types';
import type { TaskDTO } from '@/services/task.service';
import { useSessionStringSet } from '@/lib/use-session-state';
import { MultiSelectFilter } from '@/components/multi-select-filter';
import { filterTreeByStatus } from '@/lib/task-tree-utils';

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

const ALL_STATUS_KEYS = Object.keys(TASK_STATUSES) as Array<keyof typeof TASK_STATUSES>;

/**
 * マイタスクのクライアントコンポーネント。
 *
 * 折りたたみ / フィルタ仕様 (PR #61):
 *   - WBS 画面と同じく「WP はデフォルト折りたたみ」に統一
 *   - プロジェクト / WP の展開状態は sessionStorage で保持 (同一タブ内で永続)
 *   - 状況 (task status) の複数選択フィルタを追加 (デフォルト全選択)
 */
export function MyTasksClient({ projectGroups, today }: Props) {
  // 展開状態は「expanded ID の Set」で表現する (空=すべて折りたたみ)。
  // セッション内で明示的に展開した項目だけが残り、新規セッションでは空に戻る。
  const [expandedProjects, setExpandedProjects] = useSessionStringSet(
    'my-tasks:expanded-projects',
    () => [],
  );
  const [expandedTasks, setExpandedTasks] = useSessionStringSet(
    'my-tasks:expanded-tasks',
    () => [],
  );
  const [selectedStatuses, setSelectedStatuses] = useSessionStringSet(
    'my-tasks:statuses',
    () => [...ALL_STATUS_KEYS],
  );

  const toggleProject = useCallback((projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, [setExpandedProjects]);
  const toggleTask = useCallback((taskId: string) => {
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, [setExpandedTasks]);
  const toggleStatus = useCallback((key: string) => {
    setSelectedStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [setSelectedStatuses]);
  const selectAllStatuses = useCallback(() => {
    setSelectedStatuses(() => new Set(ALL_STATUS_KEYS));
  }, [setSelectedStatuses]);
  const clearAllStatuses = useCallback(() => {
    setSelectedStatuses(() => new Set());
  }, [setSelectedStatuses]);

  const isAllStatusesSelected
    = selectedStatuses.size === ALL_STATUS_KEYS.length
    && ALL_STATUS_KEYS.every((k) => selectedStatuses.has(k));

  const filteredGroups = useMemo(() => {
    if (isAllStatusesSelected) return projectGroups;
    return projectGroups
      .map((pg) => ({ ...pg, tree: filterTreeByStatus(pg.tree, selectedStatuses) }))
      .filter((pg) => pg.tree.length > 0);
  }, [projectGroups, selectedStatuses, isAllStatusesSelected]);

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
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">マイタスク</h2>
        <div className="flex items-center gap-2">
          <MultiSelectFilter
            label="状況"
            options={ALL_STATUS_KEYS.map((k) => ({ value: k, label: TASK_STATUSES[k] }))}
            selected={selectedStatuses}
            onToggle={toggleStatus}
            onSelectAll={selectAllStatuses}
            onClearAll={clearAllStatuses}
            isAllSelected={isAllStatusesSelected}
          />
          {!isAllStatusesSelected && (
            <Button type="button" variant="ghost" size="sm" onClick={selectAllStatuses}>
              フィルタ解除
            </Button>
          )}
        </div>
      </div>

      {filteredGroups.length === 0 && (
        <p className="py-8 text-center text-gray-500">該当するタスクがありません</p>
      )}

      {filteredGroups.map((pg) => {
        const isProjectExpanded = expandedProjects.has(pg.projectId);
        return (
          <div key={pg.projectId} className="rounded-lg border overflow-x-auto">
            {/* プロジェクトセクションヘッダ (クリックで開閉) */}
            <div className="flex items-center gap-2 border-b bg-gray-50 px-3 py-2">
              <button
                type="button"
                onClick={() => toggleProject(pg.projectId)}
                className="flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-gray-200"
                aria-label={isProjectExpanded ? '折りたたみ' : '展開'}
              >
                <span className={`text-xs transition-transform ${isProjectExpanded ? 'rotate-90' : ''}`}>▶</span>
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

            {isProjectExpanded && (
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
                    <TaskRow
                      key={task.id}
                      task={task}
                      depth={0}
                      today={today}
                      expandedTasks={expandedTasks}
                      onToggleTask={toggleTask}
                    />
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
 * 再帰的なタスク行 (WBS 画面と同じ「WP デフォルト折りたたみ」仕様)。
 * 展開状態は親の Set で一元管理され、sessionStorage に永続化される。
 */
function TaskRow({
  task,
  depth,
  today,
  expandedTasks,
  onToggleTask,
}: {
  task: TaskDTO;
  depth: number;
  today: string;
  expandedTasks: Set<string>;
  onToggleTask: (id: string) => void;
}) {
  const isWP = task.type === 'work_package';
  const hasChildren = task.children && task.children.length > 0;
  // WP のみ折りたたみ対象。ACT は常に展開表示。
  const isExpanded = !isWP || !hasChildren || expandedTasks.has(task.id);

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
                onClick={() => onToggleTask(task.id)}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-200"
              >
                <span className={`text-xs transition-transform ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
              </button>
            ) : (
              <span className="w-5 shrink-0" />
            )}
            <Badge variant={isWP ? 'default' : 'outline'} className="shrink-0 text-[10px] px-1.5 py-0">
              {isWP ? 'WP' : 'ACT'}
            </Badge>
            <span className={isWP ? 'font-semibold' : 'font-medium'}>{task.name}</span>
            {task.wbsNumber && <span className="text-xs text-gray-400">{task.wbsNumber}</span>}
            {isWP && hasChildren && !isExpanded && (
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
      {isExpanded && task.children?.map((child) => (
        <TaskRow
          key={child.id}
          task={child}
          depth={depth + 1}
          today={today}
          expandedTasks={expandedTasks}
          onToggleTask={onToggleTask}
        />
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

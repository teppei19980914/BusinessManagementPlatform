'use client';

/**
 * マイタスク画面 (PR #69 でナビ撤去 → アカウントメニュー配下に移動) のクライアント側。
 *
 * 役割:
 *   ログイン中ユーザの担当タスクを全プロジェクト横断で集約表示する個人ビュー。
 *   プロジェクト別グルーピング + ステータス絞込 + 各タスクから親プロジェクトへの導線あり。
 *
 * 表示対象:
 *   tasks.assignee_id = 自分 のみ (WP は assignee を持たないため対象外)。
 *
 * 認可: 本人のタスクのみ閲覧可。他人のマイタスクは見えない。
 * API: /api/my-tasks
 *
 * 関連:
 *   - SPECIFICATION.md (マイタスク画面)
 *   - DESIGN.md §15 (idx_tasks_assignee インデックスで高速化)
 */

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TASK_STATUSES, PRIORITIES } from '@/types';
import type { TaskDTO } from '@/services/task.service';
import { useSessionStringSet } from '@/lib/use-session-state';
import { MultiSelectFilter } from '@/components/multi-select-filter';
import { filterTreeByStatus, taskStatusColors } from '@/lib/task-tree-utils';
import {
  ResizableColumnsProvider,
  ResizableHead,
  ResetColumnsButton,
} from '@/components/ui/resizable-columns';
// feat/gantt-tab-restructure (PR-C item 7): マイタスクに横断 Gantt 表示
import { GanttClient } from '@/app/(dashboard)/projects/[projectId]/gantt/gantt-client';

type ProjectGroup = {
  projectId: string;
  projectName: string;
  tree: TaskDTO[];
};

type Props = {
  projectGroups: ProjectGroup[];
  /** サーバ側で算出した本日日付 (YYYY-MM-DD)。遅延判定のハイドレーション安全化に使用 */
  today: string;
  /** feat/gantt-tab-restructure (PR-C item 7): Gantt 表示時の担当者フィルタ初期値 */
  currentUserId: string;
  currentUserName: string;
};

// 旧ローカル statusColors は lib/task-tree-utils.ts の taskStatusColors に集約 (PR #63 DRY)
const statusColors = taskStatusColors;

const ALL_STATUS_KEYS = Object.keys(TASK_STATUSES) as Array<keyof typeof TASK_STATUSES>;

/**
 * マイタスクのクライアントコンポーネント。
 *
 * 折りたたみ / フィルタ仕様 (PR #61):
 *   - WBS 画面と同じく「WP はデフォルト折りたたみ」に統一
 *   - プロジェクト / WP の展開状態は sessionStorage で保持 (同一タブ内で永続)
 *   - 状況 (task status) の複数選択フィルタを追加 (デフォルト全選択)
 */
export function MyTasksClient({ projectGroups, today, currentUserId, currentUserName }: Props) {
  const tMyTask = useTranslations('myTask');
  // feat/gantt-tab-restructure (PR-C item 7): Gantt 表示トグル
  const [showGantt, setShowGantt] = useState(false);
  // GanttClient は members props (担当者フィルタ用) を受け取るため、自分のみの 1 件配列を作る。
  // MemberDTO の型を満たすため id / userEmail / createdAt はダミー値で埋める (filter 表示にしか
  // 使われない)。
  const ganttMembers = useMemo(
    () => [{
      id: 'me',
      userId: currentUserId,
      userName: currentUserName,
      userEmail: '',
      projectRole: 'member',
      createdAt: '',
    }],
    [currentUserId, currentUserName],
  );
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
        <h2 className="text-xl font-semibold">{tMyTask('title')}</h2>
        <p className="py-8 text-center text-muted-foreground">{tMyTask('noAssigned')}</p>
      </div>
    );
  }

  return (
    <ResizableColumnsProvider tableKey="my-tasks">
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{tMyTask('title')}</h2>
        <div className="flex items-center gap-2">
          {/* feat/gantt-tab-restructure (PR-C item 7): 横断 Gantt 表示トグル */}
          <Button variant="outline" size="sm" onClick={() => setShowGantt((v) => !v)}>
            {showGantt ? tMyTask('hideGantt') : tMyTask('showGantt')}
          </Button>
          <ResetColumnsButton />
          <MultiSelectFilter
            label={tMyTask('statusFilter')}
            options={ALL_STATUS_KEYS.map((k) => ({ value: k, label: TASK_STATUSES[k] }))}
            selected={selectedStatuses}
            onToggle={toggleStatus}
            onSelectAll={selectAllStatuses}
            onClearAll={clearAllStatuses}
            isAllSelected={isAllStatusesSelected}
          />
          {!isAllStatusesSelected && (
            <Button type="button" variant="ghost" size="sm" onClick={selectAllStatuses}>
              {tMyTask('clearFilter')}
            </Button>
          )}
        </div>
      </div>

      {/* feat/gantt-tab-restructure (PR-C item 7): 横断 Gantt 表示エリア。
          複数プロジェクトを縦に並べる (各 GanttClient は単一プロジェクトに対応するため、
          プロジェクト単位で順次描画する)。 */}
      {showGantt && (
        <div className="space-y-4">
          {filteredGroups.map((pg) => (
            <div key={`gantt-${pg.projectId}`} className="rounded-lg border p-2">
              <Link
                href={`/projects/${pg.projectId}`}
                className="mb-2 inline-block text-sm font-semibold text-info hover:underline"
              >
                {pg.projectName}
              </Link>
              <GanttClient projectId={pg.projectId} tasks={pg.tree} members={ganttMembers} />
            </div>
          ))}
        </div>
      )}

      {filteredGroups.length === 0 && (
        <p className="py-8 text-center text-muted-foreground">{tMyTask('noMatch')}</p>
      )}

      {filteredGroups.map((pg) => {
        const isProjectExpanded = expandedProjects.has(pg.projectId);
        return (
          <div key={pg.projectId} className="rounded-lg border overflow-x-auto">
            {/* プロジェクトセクションヘッダ (クリックで開閉) */}
            <div className="flex items-center gap-2 border-b bg-muted px-3 py-2">
              <button
                type="button"
                onClick={() => toggleProject(pg.projectId)}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                aria-label={isProjectExpanded ? tMyTask('collapse') : tMyTask('expand')}
              >
                <span className={`text-xs transition-transform ${isProjectExpanded ? 'rotate-90' : ''}`}>▶</span>
              </button>
              <Link
                href={`/projects/${pg.projectId}`}
                className="font-semibold text-info hover:underline"
              >
                {pg.projectName}
              </Link>
              <span className="text-xs text-muted-foreground">
                {tMyTask('count', { count: countActivities(pg.tree) })}
              </span>
            </div>

            {isProjectExpanded && (
              <table className="min-w-full text-xs md:text-sm">
                <thead className="bg-card">
                  <tr>
                    <ResizableHead columnKey="name" defaultWidth={300}>{tMyTask('colName')}</ResizableHead>
                    <ResizableHead columnKey="status" defaultWidth={100}>{tMyTask('colStatus')}</ResizableHead>
                    <ResizableHead columnKey="progress" defaultWidth={140}>{tMyTask('colProgressEffort')}</ResizableHead>
                    <ResizableHead columnKey="plannedRange" defaultWidth={180}>{tMyTask('colPlannedRange')}</ResizableHead>
                    <ResizableHead columnKey="actualRange" defaultWidth={180}>{tMyTask('colActualRange')}</ResizableHead>
                    <ResizableHead columnKey="priority" defaultWidth={80}>{tMyTask('colPriority')}</ResizableHead>
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
    </ResizableColumnsProvider>
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
  const tMyTask = useTranslations('myTask');
  const isWP = task.type === 'work_package';
  const hasChildren = task.children && task.children.length > 0;
  // WP のみ折りたたみ対象。ACT は常に展開表示。
  const isExpanded = !isWP || !hasChildren || expandedTasks.has(task.id);

  const unsetLabel = tMyTask('unset');
  const plannedRangeText = (() => {
    if (!task.plannedStartDate && !task.plannedEndDate) return '-';
    return `${task.plannedStartDate || unsetLabel} 〜 ${task.plannedEndDate || unsetLabel}`;
  })();
  const actualRangeText = (() => {
    if (!task.actualStartDate && !task.actualEndDate) return '-';
    return `${task.actualStartDate || unsetLabel} 〜 ${task.actualEndDate || unsetLabel}`;
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
      <tr className={`border-b hover:bg-muted ${isWP ? 'bg-muted/50' : ''} ${isDelayed ? 'bg-destructive/10' : ''}`}>
        <td
          className="px-1.5 py-1.5 md:px-3 md:py-2"
          style={{ paddingLeft: `${depth * 20 + 8}px` }}
        >
          <div className="flex items-center gap-1.5 md:gap-2">
            {isWP && hasChildren ? (
              <button
                type="button"
                onClick={() => onToggleTask(task.id)}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent"
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
            {task.wbsNumber && <span className="text-xs text-muted-foreground">{task.wbsNumber}</span>}
            {isWP && hasChildren && !isExpanded && (
              <span className="text-xs text-muted-foreground">({task.children!.length})</span>
            )}
            {isDelayed && <Badge variant="destructive" className="ml-1 text-[10px]">{tMyTask('delayed')}</Badge>}
          </div>
        </td>
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">
          <Badge variant={statusColors[task.status] || 'outline'}>
            {TASK_STATUSES[task.status as keyof typeof TASK_STATUSES] || task.status}
          </Badge>
        </td>
        <td className="px-1.5 py-1.5 md:px-3 md:py-2 whitespace-nowrap">
          <div className="flex items-center gap-1.5 md:gap-2">
            <div className="h-2 w-10 md:w-16 rounded-full bg-accent">
              <div className="h-2 rounded-full bg-info" style={{ width: `${task.progressRate}%` }} />
            </div>
            <span>{task.progressRate}%</span>
            {effortText && <span className="text-xs text-muted-foreground">/ {effortText}</span>}
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

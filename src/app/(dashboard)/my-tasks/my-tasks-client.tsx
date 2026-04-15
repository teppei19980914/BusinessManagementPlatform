'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { TASK_STATUSES, PRIORITIES } from '@/types';

type MyTask = {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  status: string;
  progressRate: number;
  plannedStartDate: string;
  plannedEndDate: string;
  priority: string | null;
  isDelayed: boolean;
};

type Props = { tasks: MyTask[] };

const statusColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  not_started: 'outline',
  in_progress: 'default',
  completed: 'secondary',
  on_hold: 'destructive',
};

export function MyTasksClient({ tasks }: Props) {
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">マイタスク</h2>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>プロジェクト</TableHead>
            <TableHead>タスク名</TableHead>
            <TableHead>ステータス</TableHead>
            <TableHead>進捗</TableHead>
            <TableHead>優先度</TableHead>
            <TableHead>終了予定日</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((t) => (
            <TableRow key={t.id} className={t.isDelayed ? 'bg-red-50' : ''}>
              <TableCell>
                <Link href={`/projects/${t.projectId}`} className="text-blue-600 hover:underline text-sm">
                  {t.projectName}
                </Link>
              </TableCell>
              <TableCell>
                <Link href={`/projects/${t.projectId}/tasks`} className="font-medium hover:underline">
                  {t.name}
                </Link>
                {t.isDelayed && <Badge variant="destructive" className="ml-2">遅延</Badge>}
              </TableCell>
              <TableCell>
                <Badge variant={statusColors[t.status] || 'outline'}>
                  {TASK_STATUSES[t.status as keyof typeof TASK_STATUSES] || t.status}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <div className="h-2 w-16 rounded-full bg-gray-200">
                    <div className="h-2 rounded-full bg-blue-500" style={{ width: `${t.progressRate}%` }} />
                  </div>
                  <span className="text-sm">{t.progressRate}%</span>
                </div>
              </TableCell>
              <TableCell>
                {t.priority && <Badge variant="secondary">{PRIORITIES[t.priority as keyof typeof PRIORITIES]}</Badge>}
              </TableCell>
              <TableCell className={t.isDelayed ? 'text-red-600 font-medium' : ''}>{t.plannedEndDate}</TableCell>
            </TableRow>
          ))}
          {tasks.length === 0 && (
            <TableRow><TableCell colSpan={6} className="py-8 text-center text-gray-500">担当タスクがありません</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

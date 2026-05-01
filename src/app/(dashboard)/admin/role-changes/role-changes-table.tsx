'use client';

/**
 * ロール変更ログ一覧テーブル (PR feat/sortable-columns / 2026-05-01)。
 * audit-logs-table と同じパターン: 整形済の rows を server 側から受け取り、client でソートのみ提供。
 */

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { SortableHeader } from '@/components/sort/sortable-header';
import { useMultiSort } from '@/components/sort/use-multi-sort';
import { multiSort } from '@/lib/multi-sort';

export type RoleChangeRow = {
  id: string;
  createdAtIso: string;
  createdAtDisplay: string;
  changerName: string;
  targetUserName: string;
  changeType: string;
  beforeRole: string | null;
  afterRole: string;
  reason: string | null;
};

function getRoleChangeSortValue(r: RoleChangeRow, columnKey: string): unknown {
  switch (columnKey) {
    case 'createdAt': return r.createdAtIso;
    case 'changer': return r.changerName;
    case 'targetUser': return r.targetUserName;
    case 'changeType': return r.changeType;
    case 'beforeRole': return r.beforeRole ?? '';
    case 'afterRole': return r.afterRole;
    case 'reason': return r.reason ?? '';
    default: return null;
  }
}

export function RoleChangesTable({ logs }: { logs: RoleChangeRow[] }) {
  const t = useTranslations('admin.roleChanges');
  const { sortState, setSortColumn } = useMultiSort('sort:admin-role-changes');
  const sorted = multiSort(logs, sortState, getRoleChangeSortValue);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <SortableHeader columnKey="createdAt" label={t('columnDateTime')} sortState={sortState} onSortChange={setSortColumn} />
          </TableHead>
          <TableHead>
            <SortableHeader columnKey="changer" label={t('columnChanger')} sortState={sortState} onSortChange={setSortColumn} />
          </TableHead>
          <TableHead>
            <SortableHeader columnKey="targetUser" label={t('columnTargetUser')} sortState={sortState} onSortChange={setSortColumn} />
          </TableHead>
          <TableHead>
            <SortableHeader columnKey="changeType" label={t('columnChangeType')} sortState={sortState} onSortChange={setSortColumn} />
          </TableHead>
          <TableHead>
            <SortableHeader columnKey="beforeRole" label={t('columnBeforeRole')} sortState={sortState} onSortChange={setSortColumn} />
          </TableHead>
          <TableHead>
            <SortableHeader columnKey="afterRole" label={t('columnAfterRole')} sortState={sortState} onSortChange={setSortColumn} />
          </TableHead>
          <TableHead>
            <SortableHeader columnKey="reason" label={t('columnReason')} sortState={sortState} onSortChange={setSortColumn} />
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((log) => (
          <TableRow key={log.id}>
            <TableCell className="text-sm">{log.createdAtDisplay}</TableCell>
            <TableCell className="text-sm">{log.changerName}</TableCell>
            <TableCell className="text-sm">{log.targetUserName}</TableCell>
            <TableCell><Badge variant="secondary">{log.changeType}</Badge></TableCell>
            <TableCell className="text-sm">{log.beforeRole || '-'}</TableCell>
            <TableCell className="text-sm font-medium">{log.afterRole}</TableCell>
            <TableCell className="text-sm text-muted-foreground">{log.reason || '-'}</TableCell>
          </TableRow>
        ))}
        {sorted.length === 0 && (
          <TableRow>
            <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">{t('noLogs')}</TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

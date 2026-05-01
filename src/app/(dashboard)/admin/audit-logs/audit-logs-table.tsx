'use client';

/**
 * 監査ログ一覧テーブル (PR feat/sortable-columns / 2026-05-01)。
 *
 * page.tsx (server component) で取得 + 表示用整形済の rows を受け取り、
 * カラムソート + sessionStorage 永続化を提供する client component。
 *
 * 整形済データを受け取る理由:
 *   formatDateTimeFull はユーザ session の TZ/locale を server で参照する必要があり、
 *   client 側で再現すると依存が増えるため、整形済 string を渡してクライアントは表示するだけ。
 */

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { SortableHeader } from '@/components/sort/sortable-header';
import { useMultiSort } from '@/components/sort/use-multi-sort';
import { multiSort } from '@/lib/multi-sort';

export type AuditLogRow = {
  id: string;
  createdAtIso: string;
  createdAtDisplay: string;
  userName: string;
  action: string;
  entityType: string;
  entityId: string;
};

function getAuditLogSortValue(r: AuditLogRow, columnKey: string): unknown {
  switch (columnKey) {
    case 'createdAt': return r.createdAtIso;
    case 'operator': return r.userName;
    case 'action': return r.action;
    case 'target': return r.entityType;
    case 'targetId': return r.entityId;
    default: return null;
  }
}

export function AuditLogsTable({ logs }: { logs: AuditLogRow[] }) {
  const t = useTranslations('admin.auditLogs');
  const { sortState, setSortColumn } = useMultiSort('sort:admin-audit-logs');
  const sorted = multiSort(logs, sortState, getAuditLogSortValue);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <SortableHeader columnKey="createdAt" label={t('columnDateTime')} sortState={sortState} onSortChange={setSortColumn} />
          </TableHead>
          <TableHead>
            <SortableHeader columnKey="operator" label={t('columnOperator')} sortState={sortState} onSortChange={setSortColumn} />
          </TableHead>
          <TableHead>
            <SortableHeader columnKey="action" label={t('columnAction')} sortState={sortState} onSortChange={setSortColumn} />
          </TableHead>
          <TableHead>
            <SortableHeader columnKey="target" label={t('columnTarget')} sortState={sortState} onSortChange={setSortColumn} />
          </TableHead>
          <TableHead>
            <SortableHeader columnKey="targetId" label={t('columnTargetId')} sortState={sortState} onSortChange={setSortColumn} />
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((log) => (
          <TableRow key={log.id}>
            <TableCell className="text-sm">{log.createdAtDisplay}</TableCell>
            <TableCell className="text-sm">{log.userName}</TableCell>
            <TableCell>
              <Badge variant={log.action === 'DELETE' ? 'destructive' : log.action === 'CREATE' ? 'default' : 'secondary'}>
                {log.action}
              </Badge>
            </TableCell>
            <TableCell className="text-sm">{log.entityType}</TableCell>
            <TableCell className="text-xs font-mono text-muted-foreground">{log.entityId.slice(0, 8)}...</TableCell>
          </TableRow>
        ))}
        {sorted.length === 0 && (
          <TableRow>
            <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">{t('noLogs')}</TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

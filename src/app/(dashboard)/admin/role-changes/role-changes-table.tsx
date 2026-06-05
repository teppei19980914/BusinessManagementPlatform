'use client';

/**
 * ロール変更ログ一覧テーブル (PR feat/sortable-columns / 2026-05-01)。
 * audit-logs-table と同じパターン: 整形済の rows を server 側から受け取り、client で
 * 絞り込み・並び替え・列幅調整・ページング・表示件数切替を提供する。
 *
 * 2026-06-03: 監査ログ画面と機能を統一。
 *   - 画面見出しは page.tsx 側で撤去
 *   - 変更者 / 対象ユーザ / 種別 / キーワードの絞り込み + 件数表示
 *   - 列幅調整 + 「列幅をリセット」(ResizableTableShell、表の右上・統一位置)
 *   - 100 行/ページのページネーション、表示件数 (100/300/1000/全件) 選択
 *   - 種別・ロールはロケール表示 (page.tsx で変換済み)
 */

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import { TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { ResizableTableShell } from '@/components/common/resizable-table-shell';
import { SortableResizableHead } from '@/components/sort/sortable-resizable-head';
import { useTablePagination, TablePagination } from '@/components/common/table-pagination';
import { useMultiSort } from '@/components/sort/use-multi-sort';
import { multiSort } from '@/lib/multi-sort';

export type RoleChangeRow = {
  id: string;
  createdAtIso: string;
  createdAtDisplay: string;
  changerName: string;
  targetUserName: string;
  // 種別・前後ロールはロケール/ラベル表示済み文字列 (page.tsx で変換)
  changeTypeDisplay: string;
  beforeRoleDisplay: string;
  afterRoleDisplay: string;
  reason: string | null;
};

function getRoleChangeSortValue(r: RoleChangeRow, columnKey: string): unknown {
  switch (columnKey) {
    case 'createdAt': return r.createdAtIso;
    case 'changer': return r.changerName;
    case 'targetUser': return r.targetUserName;
    case 'changeType': return r.changeTypeDisplay;
    case 'beforeRole': return r.beforeRoleDisplay;
    case 'afterRole': return r.afterRoleDisplay;
    case 'reason': return r.reason ?? '';
    default: return null;
  }
}

export function RoleChangesTable({
  logs,
  currentLimit,
  limitOptions,
  isCapped,
}: {
  logs: RoleChangeRow[];
  currentLimit: string;
  limitOptions: string[];
  isCapped: boolean;
}) {
  const t = useTranslations('admin.roleChanges');
  const router = useRouter();
  const searchParams = useSearchParams();
  const { sortState, setSortColumn } = useMultiSort('sort:admin-role-changes');

  // 表示件数 (取得上限) を ?limit= で切替
  const onLimitChange = (v: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('limit', v);
    router.push(`?${params.toString()}`);
  };
  const limitLabel = (v: string) =>
    v === 'all' ? t('limitOptionAll') : t('limitOptionCount', { count: Number(v) });

  // 絞り込み state
  const [changerFilter, setChangerFilter] = useState('');
  const [targetFilter, setTargetFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [keyword, setKeyword] = useState('');

  const changerOptions = useMemo(
    () => Array.from(new Set(logs.map((r) => r.changerName))).sort(), [logs]);
  const targetOptions = useMemo(
    () => Array.from(new Set(logs.map((r) => r.targetUserName))).sort(), [logs]);
  const typeOptions = useMemo(
    () => Array.from(new Set(logs.map((r) => r.changeTypeDisplay))).sort(), [logs]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return logs.filter((r) => {
      if (changerFilter && r.changerName !== changerFilter) return false;
      if (targetFilter && r.targetUserName !== targetFilter) return false;
      if (typeFilter && r.changeTypeDisplay !== typeFilter) return false;
      if (kw) {
        const hay = `${r.changerName} ${r.targetUserName} ${r.changeTypeDisplay} ${r.beforeRoleDisplay} ${r.afterRoleDisplay} ${r.reason ?? ''}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [logs, changerFilter, targetFilter, typeFilter, keyword]);

  const sorted = multiSort(filtered, sortState, getRoleChangeSortValue);
  const { pageItems, page, pageCount, setPage } = useTablePagination(
    sorted,
    `${changerFilter}|${targetFilter}|${typeFilter}|${keyword}`,
  );

  return (
    <div className="space-y-3">
      {/* 絞り込み + 表示件数 + 件数表示 (監査ログと統一) */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder={t('searchPlaceholder')}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          className="max-w-xs"
        />
        <select className={nativeSelectClass + ' max-w-[12rem]'} value={changerFilter} onChange={(e) => setChangerFilter(e.target.value)}>
          <option value="">{t('filterChangerAll')}</option>
          {changerOptions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className={nativeSelectClass + ' max-w-[12rem]'} value={targetFilter} onChange={(e) => setTargetFilter(e.target.value)}>
          <option value="">{t('filterTargetAll')}</option>
          {targetOptions.map((tg) => <option key={tg} value={tg}>{tg}</option>)}
        </select>
        <select className={nativeSelectClass + ' max-w-[12rem]'} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">{t('filterTypeAll')}</option>
          {typeOptions.map((tp) => <option key={tp} value={tp}>{tp}</option>)}
        </select>
        <label className="ml-auto flex items-center gap-1 text-sm text-muted-foreground">
          {t('limitLabel')}
          <select
            className={nativeSelectClass + ' max-w-[8rem]'}
            value={currentLimit}
            onChange={(e) => onLimitChange(e.target.value)}
          >
            {limitOptions.map((v) => <option key={v} value={v}>{limitLabel(v)}</option>)}
          </select>
        </label>
        <span className="text-sm text-muted-foreground">
          {t('countDisplay', { shown: sorted.length, total: logs.length })}
          {isCapped && ` ${t('limitNote', { limit: Number(currentLimit) })}`}
        </span>
      </div>

      {/* 列幅調整 + 「列幅をリセット」(表の右上・統一位置) */}
      <ResizableTableShell tableKey="admin-role-changes">
        <TableHeader>
          <TableRow>
            <SortableResizableHead columnKey="createdAt" defaultWidth={170} label={t('columnDateTime')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="changer" defaultWidth={150} label={t('columnChanger')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="targetUser" defaultWidth={150} label={t('columnTargetUser')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="changeType" defaultWidth={150} label={t('columnChangeType')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="beforeRole" defaultWidth={140} label={t('columnBeforeRole')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="afterRole" defaultWidth={140} label={t('columnAfterRole')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="reason" defaultWidth={240} label={t('columnReason')} sortState={sortState} onSortChange={setSortColumn} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageItems.map((log) => (
            <TableRow key={log.id}>
              <TableCell className="whitespace-nowrap text-sm">{log.createdAtDisplay}</TableCell>
              <TableCell className="text-sm">{log.changerName}</TableCell>
              <TableCell className="text-sm">{log.targetUserName}</TableCell>
              <TableCell><Badge variant="secondary">{log.changeTypeDisplay}</Badge></TableCell>
              <TableCell className="text-sm">{log.beforeRoleDisplay || '-'}</TableCell>
              <TableCell className="text-sm font-medium">{log.afterRoleDisplay}</TableCell>
              <TableCell className="truncate text-sm text-muted-foreground" title={log.reason || undefined}>{log.reason || '-'}</TableCell>
            </TableRow>
          ))}
          {sorted.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">{t('noLogs')}</TableCell>
            </TableRow>
          )}
        </TableBody>
      </ResizableTableShell>

      <TablePagination page={page} pageCount={pageCount} onPageChange={setPage} />
    </div>
  );
}

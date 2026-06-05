'use client';

/**
 * 監査ログ一覧テーブル (PR feat/sortable-columns / 2026-05-01)。
 *
 * page.tsx (server component) で取得 + 表示用整形済の rows を受け取り、
 * カラムソート + sessionStorage 永続化 + 絞り込み (client 側) を提供する client component。
 *
 * 整形済データを受け取る理由:
 *   formatDateTimeFull はユーザ session の TZ/locale を server で参照する必要があり、
 *   client 側で再現すると依存が増えるため、整形済 string を渡してクライアントは表示するだけ。
 *
 * 2026-06-03:
 *   - 対象「名前」列を追加 (#3、監査 JSON から name/title 等を推定済みの値を表示)。
 *   - リスク/課題は別行として表示 (#1、page.tsx で JSON.type により entityDisplay を振り分け済み)。
 *   - 操作種別 / 対象種別 / 操作者 / キーワードでの絞り込み + 件数表示 (#2)。取得は最新 300 件。
 */

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { useTablePagination, TablePagination } from '@/components/common/table-pagination';
import { Input } from '@/components/ui/input';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import {
  TableBody, TableCell, TableHeader, TableRow,
} from '@/components/ui/table';
// 2026-06-03: 他一覧と同様に列幅調整 + 「列幅をリセット」(統一位置) を持たせる共通シェル
import { ResizableTableShell } from '@/components/common/resizable-table-shell';
import { SortableResizableHead } from '@/components/sort/sortable-resizable-head';
import { useMultiSort } from '@/components/sort/use-multi-sort';
import { multiSort } from '@/lib/multi-sort';

export type AuditLogRow = {
  id: string;
  createdAtIso: string;
  createdAtDisplay: string;
  userName: string;
  // action は raw 値 (バッジ色の判定に使用)、actionDisplay はロケール翻訳済み表示文字列
  action: string;
  actionDisplay: string;
  // entityDisplay はロケール翻訳済み表示文字列 (例: knowledge→ナレッジ、risk_issue は type で リスク/課題 に振り分け済み)
  entityDisplay: string;
  // targetName は監査 JSON から推定した対象の名前 (無ければ空文字)
  targetName: string;
};

function getAuditLogSortValue(r: AuditLogRow, columnKey: string): unknown {
  switch (columnKey) {
    case 'createdAt': return r.createdAtIso;
    case 'operator': return r.userName;
    case 'action': return r.actionDisplay;
    case 'target': return r.entityDisplay;
    case 'targetName': return r.targetName;
    default: return null;
  }
}

export function AuditLogsTable({
  logs,
  currentLimit,
  limitOptions,
  isCapped,
}: {
  logs: AuditLogRow[];
  /** 現在の表示件数選択 ('100' | '300' | '1000' | 'all') */
  currentLimit: string;
  /** 選択肢 */
  limitOptions: string[];
  /** 取得が上限に達しているか (= さらに古いログが存在し得る) */
  isCapped: boolean;
}) {
  const t = useTranslations('admin.auditLogs');
  const router = useRouter();
  const searchParams = useSearchParams();
  const { sortState, setSortColumn } = useMultiSort('sort:admin-audit-logs');

  // 2026-06-03: 表示件数を ?limit= で切替 (サーバから読み直す)
  const onLimitChange = (v: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('limit', v);
    router.push(`?${params.toString()}`);
  };
  const limitLabel = (v: string) =>
    v === 'all' ? t('limitOptionAll') : t('limitOptionCount', { count: Number(v) });

  // 2026-06-03: 絞り込み state (client 側フィルタ)
  const [actionFilter, setActionFilter] = useState('');
  const [entityFilter, setEntityFilter] = useState('');
  const [operatorFilter, setOperatorFilter] = useState('');
  const [keyword, setKeyword] = useState('');

  // 絞り込みプルダウンの選択肢 (実データに存在する値のみ)
  const actionOptions = useMemo(
    () => Array.from(new Set(logs.map((r) => r.actionDisplay))).sort(), [logs]);
  const entityOptions = useMemo(
    () => Array.from(new Set(logs.map((r) => r.entityDisplay))).sort(), [logs]);
  const operatorOptions = useMemo(
    () => Array.from(new Set(logs.map((r) => r.userName))).sort(), [logs]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return logs.filter((r) => {
      if (actionFilter && r.actionDisplay !== actionFilter) return false;
      if (entityFilter && r.entityDisplay !== entityFilter) return false;
      if (operatorFilter && r.userName !== operatorFilter) return false;
      if (kw) {
        const hay = `${r.targetName} ${r.entityDisplay} ${r.userName} ${r.actionDisplay}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [logs, actionFilter, entityFilter, operatorFilter, keyword]);

  const sorted = multiSort(filtered, sortState, getAuditLogSortValue);

  // クライアント側ページング (共通部品)。絞り込み変更で先頭ページに戻す。
  const { pageItems: paged, page, pageCount, setPage } = useTablePagination(
    sorted,
    `${actionFilter}|${entityFilter}|${operatorFilter}|${keyword}`,
  );

  return (
    <div className="space-y-3">
      {/* 2026-06-03: 絞り込み + 件数表示 */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder={t('searchPlaceholder')}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          className="max-w-xs"
        />
        <select className={nativeSelectClass + ' max-w-[10rem]'} value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
          <option value="">{t('filterActionAll')}</option>
          {actionOptions.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select className={nativeSelectClass + ' max-w-[10rem]'} value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)}>
          <option value="">{t('filterEntityAll')}</option>
          {entityOptions.map((en) => <option key={en} value={en}>{en}</option>)}
        </select>
        <select className={nativeSelectClass + ' max-w-[12rem]'} value={operatorFilter} onChange={(e) => setOperatorFilter(e.target.value)}>
          <option value="">{t('filterOperatorAll')}</option>
          {operatorOptions.map((op) => <option key={op} value={op}>{op}</option>)}
        </select>
        {/* 2026-06-03: 表示件数 (取得上限) を画面から選択。?limit= でサーバから読み直す */}
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

      {/* 2026-06-03: 他一覧と統一。列幅ドラッグ + 「列幅をリセット」ボタン (ResizableTableShell が表の右上・統一位置に描画) */}
      <ResizableTableShell tableKey="admin-audit-logs">
        <TableHeader>
          <TableRow>
            <SortableResizableHead columnKey="createdAt" defaultWidth={170} label={t('columnDateTime')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="operator" defaultWidth={150} label={t('columnOperator')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="action" defaultWidth={130} label={t('columnAction')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="target" defaultWidth={160} label={t('columnTarget')} sortState={sortState} onSortChange={setSortColumn} />
            <SortableResizableHead columnKey="targetName" defaultWidth={260} label={t('columnTargetName')} sortState={sortState} onSortChange={setSortColumn} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {paged.map((log) => (
            <TableRow key={log.id}>
              <TableCell className="whitespace-nowrap text-sm">{log.createdAtDisplay}</TableCell>
              <TableCell className="text-sm">{log.userName}</TableCell>
              <TableCell>
                <Badge variant={log.action === 'DELETE' ? 'destructive' : log.action === 'CREATE' ? 'default' : 'secondary'}>
                  {log.actionDisplay}
                </Badge>
              </TableCell>
              <TableCell className="text-sm">{log.entityDisplay}</TableCell>
              <TableCell className="truncate text-sm" title={log.targetName || undefined}>
                {log.targetName || <span className="text-xs text-muted-foreground">—</span>}
              </TableCell>
            </TableRow>
          ))}
          {sorted.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">{t('noLogs')}</TableCell>
            </TableRow>
          )}
        </TableBody>
      </ResizableTableShell>

      {/* 2026-06-03: クライアント側ページング (全一覧共通部品)。表の直下・中央に統一配置。 */}
      <TablePagination page={page} pageCount={pageCount} onPageChange={setPage} />
    </div>
  );
}

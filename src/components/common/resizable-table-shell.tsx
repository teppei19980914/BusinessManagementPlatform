'use client';

/**
 * ResizableTableShell (Phase E 要件 1〜3 / 共通部品化, 2026-04-29):
 *
 * 「`<ResizableColumnsProvider>` + リセットボタン + `<Table>`」の 4 行ボイラープレートが
 * 10 ファイル超で重複していたため、共通シェルとして抽出。
 *
 * 元の繰り返し:
 *   <ResizableColumnsProvider tableKey="xxx">
 *     <div className="flex justify-end pb-2">
 *       <ResetColumnsButton />
 *     </div>
 *     <Table>{children}</Table>
 *   </ResizableColumnsProvider>
 *
 * 集約後:
 *   <ResizableTableShell tableKey="xxx">
 *     <TableHeader>...</TableHeader>
 *     <TableBody>...</TableBody>
 *   </ResizableTableShell>
 *
 * 設計判断:
 *   - リセットボタンの配置 (`flex justify-end pb-2`) は全画面で同一だったため固定。
 *   - 例外的にツールバー等を Table の上に追加したいケースは `topToolbar` slot で受ける
 *     (現状未使用だが将来の柔軟性のため slot 用意)。
 *   - my-tasks-client は Provider が広範囲を覆う特殊レイアウトのため対象外
 *     (ResizableColumnsProvider を直接使う既存実装を維持)。
 */

import type { ReactNode } from 'react';
import {
  ResizableColumnsProvider,
  ResetColumnsButton,
} from '@/components/ui/resizable-columns';
import { Table } from '@/components/ui/table';

type Props = {
  /** sessionStorage キー (`resizable-cols:<tableKey>`)。テーブルごとに一意。 */
  tableKey: string;
  /** リセットボタンの左に置きたい追加ツールバー (件数表示等) */
  topToolbar?: ReactNode;
  /** Table 直下に入る TableHeader / TableBody */
  children: ReactNode;
};

export function ResizableTableShell({ tableKey, topToolbar, children }: Props) {
  return (
    <ResizableColumnsProvider tableKey={tableKey}>
      <div className="flex items-center justify-end gap-2 pb-2">
        {topToolbar}
        <ResetColumnsButton />
      </div>
      <Table>{children}</Table>
    </ResizableColumnsProvider>
  );
}

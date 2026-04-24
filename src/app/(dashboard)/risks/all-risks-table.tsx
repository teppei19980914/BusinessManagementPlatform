'use client';

/**
 * 全リスク / 全課題画面 (横断表示) のテーブルコンポーネント。
 *
 * 役割:
 *   全プロジェクト横断で visibility='public' のリスク/課題を一覧表示する。
 *   PR #60 #1 でリスクと課題を別タブに分離 (本コンポーネントは type を prop で受け取る)。
 *
 * 行クリック動作:
 *   メンバーシップがあるプロジェクトの起票なら編集ダイアログ、
 *   非メンバーなら参照専用 (read-only) ダイアログを開く (PR #61)。
 *
 * 関連: SPECIFICATION.md (全リスク・全課題画面)
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHeader, TableRow,
} from '@/components/ui/table';
import { RiskEditDialog } from '@/components/dialogs/risk-edit-dialog';
import { PRIORITIES } from '@/types';
import type { AllRiskDTO } from '@/services/risk.service';
import type { MemberDTO } from '@/services/member.service';
import { AdminRiskDeleteButton } from './admin-delete-button';
// PR #119: session 連携フォーマッタ
import { useFormatters } from '@/lib/use-formatters';
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
import {
  ResizableColumnsProvider,
  ResizableHead,
  ResetColumnsButton,
} from '@/components/ui/resizable-columns';

const typeColors: Record<string, 'default' | 'destructive' | 'outline'> = {
  risk: 'outline',
  issue: 'destructive',
};

/**
 * 全リスク/課題テーブル (2026-04-24 改修: 全員読み取り専用)。
 *
 * 行クリック挙動:
 *   - 常に **read-only ダイアログ** で詳細を開く (編集不可)
 *   - 編集はプロジェクト内「リスク/課題一覧」画面から作成者本人のみ実施
 *   - 削除は admin のみ可 (テーブル右側の専用ボタン経由、全リスク/全課題からの管理削除用)
 *
 * 参考ダイアログに必要な members 情報は全プロジェクト分は持ちえないため、初期値は空リストで
 * 開始し、行クリック時に projectId から取得する遅延フェッチ戦略。
 */
export function AllRisksTable({
  risks,
  isAdmin,
  typeFilter,
}: {
  risks: AllRiskDTO[];
  isAdmin: boolean;
  /** PR #60 #1: 'risk' / 'issue' で絞り込み (未指定なら両方表示) */
  typeFilter?: 'risk' | 'issue';
}) {
  const filteredRisks = typeFilter ? risks.filter((r) => r.type === typeFilter) : risks;
  const router = useRouter();
  // PR #119: session 連携フォーマッタ
  const { formatDateTime } = useFormatters();
  const [editingRisk, setEditingRisk] = useState<AllRiskDTO | null>(null);
  const [members, setMembers] = useState<MemberDTO[]>([]);
  // PR #67: 一覧に添付列を表示するためバッチ取得
  const attachmentsByEntity = useBatchAttachments(
    'risk',
    filteredRisks.map((r) => r.id),
  );

  // 2026-04-24: 全リスク/全課題は全員 read-only (編集は ○○一覧 から作成者のみ)。
  // 参考のため担当者名を表示するので、canAccessProject=true のメンバーならメンバー一覧を
  // 取得して表示補完、非メンバーは担当者名のみ表示で済ませる。
  async function handleRowClick(r: AllRiskDTO) {
    if (r.canAccessProject) {
      try {
        const res = await fetch(`/api/projects/${r.projectId}/members`);
        if (res.ok) {
          const json = await res.json();
          setMembers(json.data ?? []);
        }
      } catch {
        setMembers([]);
      }
    } else {
      setMembers([]);
    }
    setEditingRisk(r);
  }

  const emptyMessage = typeFilter === 'issue' ? '課題がありません' : typeFilter === 'risk' ? 'リスクがありません' : 'リスク/課題がありません';

  return (
    <>
      {/* PR #128b: PC (md+) は既存テーブル (列幅ドラッグ) を維持、モバイル (md 未満) はカード並列表示 */}
      <div className="hidden md:block">
        <ResizableColumnsProvider tableKey="all-risks">
          <div className="flex justify-end pb-2">
            <ResetColumnsButton />
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <ResizableHead columnKey="project" defaultWidth={140}>プロジェクト</ResizableHead>
                {!typeFilter && <ResizableHead columnKey="type" defaultWidth={80}>種別</ResizableHead>}
                <ResizableHead columnKey="title" defaultWidth={220}>件名</ResizableHead>
                <ResizableHead columnKey="assignee" defaultWidth={120}>担当者</ResizableHead>
                <ResizableHead columnKey="impact" defaultWidth={80}>影響度</ResizableHead>
                <ResizableHead columnKey="likelihood" defaultWidth={100}>発生可能性</ResizableHead>
                <ResizableHead columnKey="priority" defaultWidth={80}>優先度</ResizableHead>
                <ResizableHead columnKey="createdAt" defaultWidth={130}>作成日時</ResizableHead>
                <ResizableHead columnKey="createdBy" defaultWidth={120}>作成者</ResizableHead>
                <ResizableHead columnKey="updatedAt" defaultWidth={130}>更新日時</ResizableHead>
                <ResizableHead columnKey="updatedBy" defaultWidth={120}>更新者</ResizableHead>
                {/* PR #67: 添付リンク列 (chips) */}
                <ResizableHead columnKey="attachments" defaultWidth={200}>添付</ResizableHead>
                {isAdmin && <ResizableHead columnKey="actions" defaultWidth={80}>操作</ResizableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRisks.map((r) => (
                <TableRow
                  key={r.id}
                  className="cursor-pointer hover:bg-muted"
                  onClick={() => handleRowClick(r)}
                >
                  <TableCell className="text-sm" onClick={(e) => e.stopPropagation()}>
                    {r.projectName == null ? (
                      <span className="text-muted-foreground">（非公開）</span>
                    ) : r.canAccessProject ? (
                      <Link href={`/projects/${r.projectId}`} className="text-info hover:underline">
                        {r.projectName}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">
                        {r.projectName}
                        {r.projectDeleted && <span className="ml-1 text-xs text-destructive">(削除済)</span>}
                      </span>
                    )}
                  </TableCell>
                  {!typeFilter && (
                    <TableCell>
                      <Badge variant={typeColors[r.type] || 'outline'}>
                        {r.type === 'risk' ? 'リスク' : '課題'}
                      </Badge>
                    </TableCell>
                  )}
                  <TableCell className="font-medium">{r.title}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {r.assigneeName ?? <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell>{PRIORITIES[r.impact as keyof typeof PRIORITIES] || r.impact}</TableCell>
                  <TableCell>
                    {r.likelihood
                      ? PRIORITIES[r.likelihood as keyof typeof PRIORITIES] || r.likelihood
                      : '-'}
                  </TableCell>
                  <TableCell>{PRIORITIES[r.priority as keyof typeof PRIORITIES] || r.priority}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDateTime(r.createdAt)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {r.createdByName ?? <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDateTime(r.updatedAt)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {r.updatedByName ?? <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  {/* PR #67: 添付リンク chips */}
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <AttachmentsCell items={attachmentsByEntity[r.id] ?? []} />
                  </TableCell>
                  {isAdmin && (
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <AdminRiskDeleteButton
                        projectId={r.projectId}
                        riskId={r.id}
                        label={r.title}
                      />
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {filteredRisks.length === 0 && (
                <TableRow>
                  {/* PR #67: 添付列を追加したので colSpan を +1 */}
                  <TableCell colSpan={(isAdmin ? 13 : 12) - (typeFilter ? 1 : 0)} className="py-8 text-center text-muted-foreground">
                    {emptyMessage}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ResizableColumnsProvider>
      </div>

      {/* PR #128b: モバイル (md 未満) 専用のカード表示 */}
      <div className="space-y-2 md:hidden" role="list" aria-label="リスク/課題一覧">
        {filteredRisks.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>
        ) : (
          filteredRisks.map((r) => (
            <div
              key={r.id}
              role="listitem"
              onClick={() => handleRowClick(r)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleRowClick(r);
                }
              }}
              tabIndex={0}
              className="cursor-pointer rounded-md border bg-card p-3 text-sm transition-colors hover:bg-muted"
            >
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {!typeFilter && (
                  <Badge variant={typeColors[r.type] || 'outline'} className="text-[10px]">
                    {r.type === 'risk' ? 'リスク' : '課題'}
                  </Badge>
                )}
                <span className="font-medium">{r.title}</span>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-xs text-muted-foreground">プロジェクト</dt>
                <dd className="text-xs" onClick={(e) => e.stopPropagation()}>
                  {r.projectName == null ? (
                    <span className="text-muted-foreground">（非公開）</span>
                  ) : r.canAccessProject ? (
                    <Link href={`/projects/${r.projectId}`} className="text-info hover:underline">
                      {r.projectName}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">
                      {r.projectName}
                      {r.projectDeleted && <span className="ml-1 text-xs text-destructive">(削除済)</span>}
                    </span>
                  )}
                </dd>
                <dt className="text-xs text-muted-foreground">担当者</dt>
                <dd className="text-xs">{r.assigneeName ?? '-'}</dd>
                <dt className="text-xs text-muted-foreground">影響度 / 可能性 / 優先度</dt>
                <dd className="text-xs">
                  {PRIORITIES[r.impact as keyof typeof PRIORITIES] || r.impact}
                  {' / '}
                  {r.likelihood ? PRIORITIES[r.likelihood as keyof typeof PRIORITIES] || r.likelihood : '-'}
                  {' / '}
                  {PRIORITIES[r.priority as keyof typeof PRIORITIES] || r.priority}
                </dd>
                <dt className="text-xs text-muted-foreground">更新</dt>
                <dd className="text-xs text-muted-foreground">
                  {formatDateTime(r.updatedAt)}
                  {r.updatedByName && ` by ${r.updatedByName}`}
                </dd>
              </dl>
              {(attachmentsByEntity[r.id]?.length ?? 0) > 0 && (
                <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                  <AttachmentsCell items={attachmentsByEntity[r.id] ?? []} />
                </div>
              )}
              {isAdmin && (
                <div className="mt-2 flex justify-end" onClick={(e) => e.stopPropagation()}>
                  <AdminRiskDeleteButton
                    projectId={r.projectId}
                    riskId={r.id}
                    label={r.title}
                  />
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <RiskEditDialog
        risk={editingRisk}
        members={members}
        open={editingRisk != null}
        onOpenChange={(v) => { if (!v) setEditingRisk(null); }}
        onSaved={async () => { router.refresh(); }}
        // 2026-04-24: 全リスク/全課題は編集不可 (読み取り専用)。編集は ○○一覧 経由。
        readOnly={true}
      />
    </>
  );
}

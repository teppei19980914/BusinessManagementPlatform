'use client';

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
import { formatDateTime } from '@/lib/format';
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
 * 全リスク/課題テーブル (Req 9: 行クリックで編集ポップアップ)。
 *
 * 行クリック挙動:
 *   - canAccessProject=true (ProjectMember または admin): 編集ダイアログを開く
 *   - canAccessProject=false (非メンバー): クリック不活性 (DTO マスキング済)
 *
 * 編集に必要な members 情報は全プロジェクト分は持ちえないため、初期値は空リストで
 * 開始し、編集ダイアログを開いた瞬間に projectId から取得する遅延フェッチ戦略。
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
  const [editingRisk, setEditingRisk] = useState<AllRiskDTO | null>(null);
  const [members, setMembers] = useState<MemberDTO[]>([]);
  // PR #67: 一覧に添付列を表示するためバッチ取得
  const attachmentsByEntity = useBatchAttachments(
    'risk',
    filteredRisks.map((r) => r.id),
  );

  // PR #61: 非メンバーでも行クリックで readOnly ダイアログを開けるようにする。
  // canAccessProject=true → 編集可、false → 参照専用 (readOnly)。
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
      // 非メンバーはメンバー一覧 API を叩けないため空で開く (担当者は表示のみ)
      setMembers([]);
    }
    setEditingRisk(r);
  }

  return (
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
                {typeFilter === 'issue' ? '課題がありません' : typeFilter === 'risk' ? 'リスクがありません' : 'リスク/課題がありません'}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <RiskEditDialog
        risk={editingRisk}
        members={members}
        open={editingRisk != null}
        onOpenChange={(v) => { if (!v) setEditingRisk(null); }}
        onSaved={async () => { router.refresh(); }}
        readOnly={editingRisk != null && !editingRisk.canAccessProject}
      />
    </ResizableColumnsProvider>
  );
}

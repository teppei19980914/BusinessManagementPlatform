'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { RiskEditDialog } from '@/components/dialogs/risk-edit-dialog';
import { PRIORITIES } from '@/types';
import type { AllRiskDTO } from '@/services/risk.service';
import type { MemberDTO } from '@/services/member.service';
import { AdminRiskDeleteButton } from './admin-delete-button';

const typeColors: Record<string, 'default' | 'destructive' | 'outline'> = {
  risk: 'outline',
  issue: 'destructive',
};

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

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
}: {
  risks: AllRiskDTO[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [editingRisk, setEditingRisk] = useState<AllRiskDTO | null>(null);
  const [members, setMembers] = useState<MemberDTO[]>([]);

  async function handleRowClick(r: AllRiskDTO) {
    if (!r.canAccessProject) return;
    // メンバーリストを取得 (編集ダイアログの担当者選択に必要)
    try {
      const res = await fetch(`/api/projects/${r.projectId}/members`);
      if (res.ok) {
        const json = await res.json();
        setMembers(json.data ?? []);
      }
    } catch {
      setMembers([]);
    }
    setEditingRisk(r);
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="whitespace-nowrap">プロジェクト</TableHead>
            <TableHead className="whitespace-nowrap">種別</TableHead>
            <TableHead>件名</TableHead>
            <TableHead className="whitespace-nowrap">担当者</TableHead>
            <TableHead className="whitespace-nowrap">影響度</TableHead>
            <TableHead className="whitespace-nowrap">発生可能性</TableHead>
            <TableHead className="whitespace-nowrap">優先度</TableHead>
            <TableHead className="whitespace-nowrap">作成日時</TableHead>
            <TableHead className="whitespace-nowrap">作成者</TableHead>
            <TableHead className="whitespace-nowrap">更新日時</TableHead>
            <TableHead className="whitespace-nowrap">更新者</TableHead>
            {isAdmin && <TableHead className="whitespace-nowrap">操作</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {risks.map((r) => (
            <TableRow
              key={r.id}
              className={r.canAccessProject ? 'cursor-pointer hover:bg-gray-50' : ''}
              onClick={() => handleRowClick(r)}
            >
              <TableCell className="text-sm" onClick={(e) => e.stopPropagation()}>
                {r.projectName == null ? (
                  <span className="text-gray-400">（非公開）</span>
                ) : r.canAccessProject ? (
                  <Link href={`/projects/${r.projectId}`} className="text-blue-600 hover:underline">
                    {r.projectName}
                  </Link>
                ) : (
                  <span className="text-gray-500">
                    {r.projectName}
                    {r.projectDeleted && <span className="ml-1 text-xs text-red-500">(削除済)</span>}
                  </span>
                )}
              </TableCell>
              <TableCell>
                <Badge variant={typeColors[r.type] || 'outline'}>
                  {r.type === 'risk' ? 'リスク' : '課題'}
                </Badge>
              </TableCell>
              <TableCell className="font-medium">{r.title}</TableCell>
              <TableCell className="text-sm text-gray-600">
                {r.assigneeName ?? <span className="text-gray-400">-</span>}
              </TableCell>
              <TableCell>{PRIORITIES[r.impact as keyof typeof PRIORITIES] || r.impact}</TableCell>
              <TableCell>
                {r.likelihood
                  ? PRIORITIES[r.likelihood as keyof typeof PRIORITIES] || r.likelihood
                  : '-'}
              </TableCell>
              <TableCell>{PRIORITIES[r.priority as keyof typeof PRIORITIES] || r.priority}</TableCell>
              <TableCell className="whitespace-nowrap text-sm text-gray-600">{formatDateTime(r.createdAt)}</TableCell>
              <TableCell className="text-sm text-gray-600">
                {r.createdByName ?? <span className="text-gray-400">-</span>}
              </TableCell>
              <TableCell className="whitespace-nowrap text-sm text-gray-600">{formatDateTime(r.updatedAt)}</TableCell>
              <TableCell className="text-sm text-gray-600">
                {r.updatedByName ?? <span className="text-gray-400">-</span>}
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
          {risks.length === 0 && (
            <TableRow>
              <TableCell colSpan={isAdmin ? 12 : 11} className="py-8 text-center text-gray-500">
                リスク/課題がありません
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
      />
    </>
  );
}

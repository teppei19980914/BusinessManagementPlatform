'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { KnowledgeEditDialog } from '@/components/dialogs/knowledge-edit-dialog';
import { KNOWLEDGE_TYPES } from '@/types';
import type { AllKnowledgeDTO } from '@/services/knowledge.service';

type Props = {
  initialKnowledge: AllKnowledgeDTO[];
  systemRole: string;
};

/**
 * 全ナレッジ画面 (Req 4 列構成: PR #55)。
 *
 * 列: プロジェクト・種別・背景・内容・結果・作成日時・作成者・更新日時・更新者
 *     (作成/削除 UI は廃止 — PR #54 で合意、CRUD はプロジェクト詳細経由のみ)
 *
 * 検索・フィルタはクライアント側で実施 (全件受け取る前提で現状は運用、
 * 件数が増えたらサーバ検索に切替を検討)。
 */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

export function KnowledgeClient({ initialKnowledge }: Props) {
  const router = useRouter();
  const [keyword, setKeyword] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  // Req 9: 行クリックで編集 (メンバーのみ canAccessProject=true で有効)
  const [editingKnowledge, setEditingKnowledge] = useState<AllKnowledgeDTO | null>(null);

  // クライアント側フィルタ (initialKnowledge をそのまま絞り込み)
  const filtered = initialKnowledge.filter((k) => {
    if (typeFilter && k.knowledgeType !== typeFilter) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const hit = [k.title, k.background, k.content, k.result]
        .some((v) => v.toLowerCase().includes(kw));
      if (!hit) return false;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">全ナレッジ</h2>
        <span className="text-sm text-gray-500">{filtered.length} 件</span>
      </div>

      {/* 検索・フィルタ */}
      <div className="flex gap-4">
        <Input
          placeholder="キーワード検索 (タイトル・背景・内容・結果)"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          className="max-w-md"
          onKeyDown={(e) => {
            if (e.key === 'Enter') router.refresh();
          }}
        />
        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v ?? '')}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="全種別" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">全種別</SelectItem>
            {Object.entries(KNOWLEDGE_TYPES).map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* 一覧 (Req 4 列構成) */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="whitespace-nowrap">プロジェクト</TableHead>
            <TableHead className="whitespace-nowrap">種別</TableHead>
            <TableHead>背景</TableHead>
            <TableHead>内容</TableHead>
            <TableHead>結果</TableHead>
            <TableHead className="whitespace-nowrap">作成日時</TableHead>
            <TableHead className="whitespace-nowrap">作成者</TableHead>
            <TableHead className="whitespace-nowrap">更新日時</TableHead>
            <TableHead className="whitespace-nowrap">更新者</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((k) => (
            <TableRow
              key={k.id}
              className={k.canAccessProject ? 'cursor-pointer hover:bg-gray-50' : ''}
              onClick={k.canAccessProject ? () => setEditingKnowledge(k) : undefined}
            >
              <TableCell className="text-sm" onClick={(e) => e.stopPropagation()}>
                {k.projectName == null ? (
                  <span className="text-gray-400">
                    {k.linkedProjectCount === 0 ? '（未紐付け）' : '（非公開）'}
                  </span>
                ) : k.canAccessProject && k.primaryProjectId ? (
                  <Link
                    href={`/projects/${k.primaryProjectId}`}
                    className="text-blue-600 hover:underline"
                  >
                    {k.projectName}
                    {k.linkedProjectCount > 1 && (
                      <span className="ml-1 text-xs text-gray-500">+{k.linkedProjectCount - 1} 他</span>
                    )}
                  </Link>
                ) : (
                  <span className="text-gray-500">
                    {k.projectName}
                    {k.projectDeleted && <span className="ml-1 text-xs text-red-500">(削除済)</span>}
                    {k.linkedProjectCount > 1 && (
                      <span className="ml-1 text-xs text-gray-400">+{k.linkedProjectCount - 1} 他</span>
                    )}
                  </span>
                )}
              </TableCell>
              <TableCell>
                <Badge variant="secondary">
                  {KNOWLEDGE_TYPES[k.knowledgeType as keyof typeof KNOWLEDGE_TYPES] || k.knowledgeType}
                </Badge>
              </TableCell>
              <TableCell className="max-w-xs truncate text-sm">{k.background || '-'}</TableCell>
              <TableCell className="max-w-xs truncate text-sm">{k.content || '-'}</TableCell>
              <TableCell className="max-w-xs truncate text-sm">{k.result || '-'}</TableCell>
              <TableCell className="whitespace-nowrap text-sm text-gray-600">
                {formatDateTime(k.createdAt)}
              </TableCell>
              <TableCell className="text-sm text-gray-600">
                {k.creatorName ?? <span className="text-gray-400">-</span>}
              </TableCell>
              <TableCell className="whitespace-nowrap text-sm text-gray-600">
                {formatDateTime(k.updatedAt)}
              </TableCell>
              <TableCell className="text-sm text-gray-600">
                {k.updatedByName ?? <span className="text-gray-400">-</span>}
              </TableCell>
            </TableRow>
          ))}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="py-8 text-center text-gray-500">
                ナレッジがありません
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <KnowledgeEditDialog
        knowledge={editingKnowledge}
        projectId={editingKnowledge?.primaryProjectId ?? null}
        open={editingKnowledge != null}
        onOpenChange={(v) => { if (!v) setEditingKnowledge(null); }}
        onSaved={async () => { router.refresh(); }}
      />
    </div>
  );
}

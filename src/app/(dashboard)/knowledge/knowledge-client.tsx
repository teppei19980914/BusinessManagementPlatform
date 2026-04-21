'use client';

/**
 * 全ナレッジ画面 (横断表示) のクライアントコンポーネント。
 *
 * 役割:
 *   プロジェクト横断でナレッジ (knowledges) を一覧・検索・新規作成する。
 *   visibility='public' の全件 + 自分が作成した draft が表示対象 (サービス層フィルタ)。
 *
 * 主な機能:
 *   - フリーテキスト検索 (title / content の pg_trgm 類似度)
 *   - knowledgeType / techTags / processTags / businessDomainTags でフィルタ
 *   - 行クリックで編集ダイアログ (KnowledgeEditDialog)
 *
 * 認可: ログイン済ユーザなら閲覧可。編集/削除は作成者本人 or admin。
 * API: /api/knowledge (GET/POST), /api/knowledge/[id] (PATCH/DELETE)
 *
 * 関連:
 *   - SPECIFICATION.md (全ナレッジ画面)
 *   - DESIGN.md §16 (全文検索 / pg_trgm)
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
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
import { formatDateTime } from '@/lib/format';
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
import {
  ResizableColumnsProvider,
  ResizableHead,
  ResetColumnsButton,
} from '@/components/ui/resizable-columns';

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

  // PR #67: 添付列用のバッチ取得 (filtered 変動で再フェッチされる)
  const attachmentsByEntity = useBatchAttachments(
    'knowledge',
    filtered.map((k) => k.id),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">全ナレッジ</h2>
        <span className="text-sm text-muted-foreground">{filtered.length} 件</span>
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
      <ResizableColumnsProvider tableKey="all-knowledge">
        <div className="flex justify-end pb-2">
          <ResetColumnsButton />
        </div>
      <Table>
        <TableHeader>
          <TableRow>
            <ResizableHead columnKey="project" defaultWidth={140}>プロジェクト</ResizableHead>
            <ResizableHead columnKey="type" defaultWidth={100}>種別</ResizableHead>
            <ResizableHead columnKey="background" defaultWidth={200}>背景</ResizableHead>
            <ResizableHead columnKey="content" defaultWidth={200}>内容</ResizableHead>
            <ResizableHead columnKey="result" defaultWidth={200}>結果</ResizableHead>
            <ResizableHead columnKey="createdAt" defaultWidth={130}>作成日時</ResizableHead>
            <ResizableHead columnKey="createdBy" defaultWidth={120}>作成者</ResizableHead>
            <ResizableHead columnKey="updatedAt" defaultWidth={130}>更新日時</ResizableHead>
            <ResizableHead columnKey="updatedBy" defaultWidth={120}>更新者</ResizableHead>
            {/* PR #67: 添付リンク列 */}
            <ResizableHead columnKey="attachments" defaultWidth={200}>添付</ResizableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((k) => (
            <TableRow
              key={k.id}
              className="cursor-pointer hover:bg-muted"
              onClick={() => setEditingKnowledge(k)}
            >
              <TableCell className="text-sm" onClick={(e) => e.stopPropagation()}>
                {k.projectName == null ? (
                  <span className="text-muted-foreground">
                    {k.linkedProjectCount === 0 ? '（未紐付け）' : '（非公開）'}
                  </span>
                ) : k.canAccessProject && k.primaryProjectId ? (
                  <Link
                    href={`/projects/${k.primaryProjectId}`}
                    className="text-info hover:underline"
                  >
                    {k.projectName}
                    {k.linkedProjectCount > 1 && (
                      <span className="ml-1 text-xs text-muted-foreground">+{k.linkedProjectCount - 1} 他</span>
                    )}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">
                    {k.projectName}
                    {k.projectDeleted && <span className="ml-1 text-xs text-destructive">(削除済)</span>}
                    {k.linkedProjectCount > 1 && (
                      <span className="ml-1 text-xs text-muted-foreground">+{k.linkedProjectCount - 1} 他</span>
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
              <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                {formatDateTime(k.createdAt)}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {k.creatorName ?? <span className="text-muted-foreground">-</span>}
              </TableCell>
              <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                {formatDateTime(k.updatedAt)}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {k.updatedByName ?? <span className="text-muted-foreground">-</span>}
              </TableCell>
              {/* PR #67: 添付リンク chips */}
              <TableCell onClick={(e) => e.stopPropagation()}>
                <AttachmentsCell items={attachmentsByEntity[k.id] ?? []} />
              </TableCell>
            </TableRow>
          ))}
          {filtered.length === 0 && (
            <TableRow>
              {/* PR #67: 添付列 +1 */}
              <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                ナレッジがありません
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      </ResizableColumnsProvider>

      <KnowledgeEditDialog
        knowledge={editingKnowledge}
        projectId={editingKnowledge?.primaryProjectId ?? null}
        open={editingKnowledge != null}
        onOpenChange={(v) => { if (!v) setEditingKnowledge(null); }}
        onSaved={async () => { router.refresh(); }}
        readOnly={editingKnowledge != null && !editingKnowledge.canAccessProject}
      />
    </div>
  );
}

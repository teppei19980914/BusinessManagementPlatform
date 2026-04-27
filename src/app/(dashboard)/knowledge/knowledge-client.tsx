'use client';

/**
 * 全ナレッジ画面 (横断表示) のクライアントコンポーネント。
 *
 * 役割:
 *   プロジェクト横断でナレッジ (knowledges) を一覧・検索表示する (PR #165 で read-only 確定)。
 *   visibility='public' の全件 + 自分が作成した draft が表示対象 (サービス層フィルタ)。
 *
 * 主な機能:
 *   - フリーテキスト検索 (title / content の pg_trgm 類似度)
 *   - knowledgeType でフィルタ
 *   - 行クリックで read-only 詳細ダイアログ (KnowledgeEditDialog readOnly=true)
 *
 * 設計ルール (PR #165 で再確定):
 *   - **「全○○」 = 参照のみ** (本画面)
 *   - **「○○一覧」 = CRUD + 一括編集** (project-tab 内 ProjectKnowledgeClient)
 *   PR #162 で誤って本画面に bulk UI を入れていたが、PR #165 で原状回復。
 *
 * 認可: ログイン済ユーザなら閲覧可。編集/削除はプロジェクト内ナレッジ一覧から作成者本人 or admin。
 * API: /api/knowledge (GET/POST), /api/knowledge/[id] (PATCH/DELETE)
 *
 * 関連:
 *   - SPECIFICATION.md (全ナレッジ画面)
 *   - DESIGN.md §16 (全文検索 / pg_trgm)
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
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
import { useFormatters } from '@/lib/use-formatters';
import { useBatchAttachments } from '@/components/attachments/use-batch-attachments';
import { AttachmentsCell } from '@/components/attachments/attachments-cell';
import {
  ResizableColumnsProvider,
  ResizableHead,
  ResetColumnsButton,
} from '@/components/ui/resizable-columns';
import { AdminKnowledgeDeleteButton } from './admin-delete-button';

type Props = {
  initialKnowledge: AllKnowledgeDTO[];
  systemRole: string;
};

export function KnowledgeClient({ initialKnowledge, systemRole }: Props) {
  const router = useRouter();
  const tKnowledge = useTranslations('knowledge');
  const { formatDateTime } = useFormatters();
  const isAdmin = systemRole === 'admin';
  const [keyword, setKeyword] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [editingKnowledge, setEditingKnowledge] = useState<AllKnowledgeDTO | null>(null);

  const filtered = initialKnowledge.filter((k) => {
    if (typeFilter && k.knowledgeType !== typeFilter) return false;
    if (keyword) {
      const lc = keyword.toLowerCase();
      const hit = [k.title, k.background, k.content, k.result]
        .some((v) => v.toLowerCase().includes(lc));
      if (!hit) return false;
    }
    return true;
  });

  const attachmentsByEntity = useBatchAttachments(
    'knowledge',
    filtered.map((k) => k.id),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{tKnowledge('headingAll')}</h2>
        <span className="text-sm text-muted-foreground">{tKnowledge('countUnit', { count: filtered.length })}</span>
      </div>

      <div className="flex gap-4">
        <Input
          placeholder={tKnowledge('searchPlaceholder')}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          className="max-w-[min(90vw,28rem)]"
          onKeyDown={(e) => {
            if (e.key === 'Enter') router.refresh();
          }}
        />
        <Select value={typeFilter || '__all__'} onValueChange={(v) => setTypeFilter((v ?? '__all__') === '__all__' ? '' : (v ?? ''))}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder={tKnowledge('all')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{tKnowledge('all')}</SelectItem>
            {Object.entries(KNOWLEDGE_TYPES).map(([key, label]) => (
              <SelectItem key={key} value={key}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ResizableColumnsProvider tableKey="all-knowledge">
        <div className="flex justify-end pb-2">
          <ResetColumnsButton />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <ResizableHead columnKey="project" defaultWidth={140}>{tKnowledge('project')}</ResizableHead>
              <ResizableHead columnKey="type" defaultWidth={100}>{tKnowledge('kind')}</ResizableHead>
              <ResizableHead columnKey="background" defaultWidth={200}>{tKnowledge('background')}</ResizableHead>
              <ResizableHead columnKey="content" defaultWidth={200}>{tKnowledge('content')}</ResizableHead>
              <ResizableHead columnKey="result" defaultWidth={200}>{tKnowledge('result')}</ResizableHead>
              <ResizableHead columnKey="createdAt" defaultWidth={130}>{tKnowledge('createdAt')}</ResizableHead>
              <ResizableHead columnKey="createdBy" defaultWidth={120}>{tKnowledge('createdBy')}</ResizableHead>
              <ResizableHead columnKey="updatedAt" defaultWidth={130}>{tKnowledge('updatedAt')}</ResizableHead>
              <ResizableHead columnKey="updatedBy" defaultWidth={120}>{tKnowledge('updatedBy')}</ResizableHead>
              <ResizableHead columnKey="attachments" defaultWidth={200}>{tKnowledge('attachment')}</ResizableHead>
              {isAdmin && <ResizableHead columnKey="actions" defaultWidth={80}>{tKnowledge('actions')}</ResizableHead>}
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
                      {k.linkedProjectCount === 0 ? tKnowledge('notLinked') : tKnowledge('private')}
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
                      {k.projectDeleted && <span className="ml-1 text-xs text-destructive">{tKnowledge('deleted')}</span>}
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
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <AttachmentsCell items={attachmentsByEntity[k.id] ?? []} />
                </TableCell>
                {isAdmin && (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <AdminKnowledgeDeleteButton knowledgeId={k.id} label={k.title} />
                  </TableCell>
                )}
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={isAdmin ? 11 : 10} className="py-8 text-center text-muted-foreground">
                  {tKnowledge('noneInList')}
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
        // 2026-04-24 + PR #165: 全ナレッジは編集不可 (読み取り専用)。編集は ○○一覧 経由。
        readOnly={true}
      />
    </div>
  );
}

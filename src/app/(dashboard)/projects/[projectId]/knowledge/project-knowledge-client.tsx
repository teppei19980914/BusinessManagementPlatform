'use client';

/**
 * プロジェクト別ナレッジ画面 (詳細タブ配下) のクライアントコンポーネント。
 *
 * 役割:
 *   このプロジェクトに紐付いたナレッジの一覧 / 追加 / 編集 / 解除を管理する。
 *   knowledge_projects テーブル経由の N:M 紐付けで、1 ナレッジは複数プロジェクトに
 *   共有可能。
 *
 * 紐付け解除と削除の差:
 *   - 解除: knowledge_projects から該当行のみ削除。ナレッジ本体は残る (他プロジェクトで参照可)
 *   - 削除: ナレッジ本体を deletedAt 設定 (作成者本人 or admin のみ)
 *
 * 認可: canEdit prop (PM/TL 以上 or admin)。
 * API: /api/projects/[id]/knowledge (GET/POST), /api/projects/[id]/knowledge/[knowledgeId] (DELETE for unlink)
 *
 * 関連: SPECIFICATION.md (プロジェクト別ナレッジ管理)
 */

import { useState } from 'react';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Trash2 } from 'lucide-react';
import { KnowledgeEditDialog } from '@/components/dialogs/knowledge-edit-dialog';
// fix/project-create-customer-validation: 重複定義を集約、全角読点 (、) 対応追加
import { parseTagsInput } from '@/lib/parse-tags';
import {
  StagedAttachmentsInput,
  persistStagedAttachments,
  type StagedAttachment,
} from '@/components/attachments/staged-attachments-input';
import { KNOWLEDGE_TYPES, VISIBILITIES } from '@/types';
import type { KnowledgeDTO } from '@/services/knowledge.service';

type Props = {
  projectId: string;
  knowledges: KnowledgeDTO[];
  /** 2026-04-24: 作成ボタンの表示可否 (実際の ProjectMember の pm_tl/member のみ true) */
  canCreate: boolean;
  /** 2026-04-24: 作成者本人判定 (k.createdBy === currentUserId で編集/削除許可) */
  currentUserId: string;
  onReload: () => Promise<void> | void;
};

const visibilityColors: Record<string, 'default' | 'secondary' | 'outline'> = {
  draft: 'outline',
  project: 'secondary',
  company: 'default',
};

/**
 * プロジェクト詳細「ナレッジ一覧」タブのクライアントコンポーネント。
 *
 * 役割:
 *   - そのプロジェクトに紐づくナレッジのみ表示 (プロジェクト scoped)
 *   - 作成: /api/projects/[projectId]/knowledge (自動で projectId に紐付け)
 *   - 削除: /api/projects/[projectId]/knowledge/[knowledgeId] (ProjectMember 認可)
 *   - 「全ナレッジ」画面と同一テーブル参照のため、ここでの CRUD は即座に
 *     /knowledge ビューにも反映される
 */
export function ProjectKnowledgeClient({
  projectId,
  knowledges,
  canCreate,
  currentUserId,
  onReload,
}: Props) {
  const { withLoading } = useLoading();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [error, setError] = useState('');
  // Req 8: 行クリックで編集ダイアログ
  const [editingKnowledge, setEditingKnowledge] = useState<KnowledgeDTO | null>(null);

  const initialForm = {
    title: '',
    knowledgeType: 'research',
    background: '',
    content: '',
    result: '',
    visibility: 'draft',
    // PR #65 Phase 2 (b): 提案精度向上のためタグ入力 (カンマ区切り)
    businessDomainTagsInput: '',
    techTagsInput: '',
    processTagsInput: '',
  };
  const [form, setForm] = useState(initialForm);

  // fix/project-create-customer-validation: 重複定義を `@/lib/parse-tags` に集約 (全角読点対応)

  // PR #67: ナレッジ作成時にステージする添付 URL (general slot)
  const [stagedCreateAttachments, setStagedCreateAttachments] = useState<StagedAttachment[]>([]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const payload = {
      title: form.title,
      knowledgeType: form.knowledgeType,
      background: form.background,
      content: form.content,
      result: form.result,
      visibility: form.visibility,
      businessDomainTags: parseTagsInput(form.businessDomainTagsInput),
      techTags: parseTagsInput(form.techTagsInput),
      processTags: parseTagsInput(form.processTagsInput),
    };

    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );

    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error?.message || json.error?.details?.[0]?.message || '作成に失敗しました');
      return;
    }

    // PR #67: 作成成功直後にステージされた添付を一括 POST
    const json = await res.json();
    if (stagedCreateAttachments.length > 0 && json.data?.id) {
      await persistStagedAttachments({
        entityType: 'knowledge',
        entityId: json.data.id,
        items: stagedCreateAttachments,
      });
    }
    setStagedCreateAttachments([]);

    setIsCreateOpen(false);
    setForm(initialForm);
    await onReload();
  }

  async function handleDelete(knowledgeId: string) {
    if (!confirm('このナレッジを削除しますか？')) return;
    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/knowledge/${knowledgeId}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      alert('削除に失敗しました');
      return;
    }
    await onReload();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">ナレッジ一覧（{knowledges.length} 件）</h3>
        {canCreate && (
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            {/* PR #124: 他「○○一覧」(risks / retrospectives) と同サイズ (px-4 py-2) に統一 */}
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">ナレッジ作成</DialogTrigger>
              <DialogContent className="max-w-[min(90vw,36rem)] max-h-[80vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>ナレッジ作成</DialogTitle>
                  <DialogDescription>
                    このプロジェクトに紐づけて登録されます。「全ナレッジ」にも自動で反映されます。
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleCreate} className="space-y-4">
                  {error && (
                    <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
                  )}
                  <div className="space-y-2">
                    <Label>タイトル</Label>
                    <Input
                      value={form.title}
                      onChange={(e) => setForm({ ...form, title: e.target.value })}
                      maxLength={150}
                      required
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>種別</Label>
                      <select
                        value={form.knowledgeType}
                        onChange={(e) => setForm({ ...form, knowledgeType: e.target.value })}
                        className={nativeSelectClass}
                      >
                        {Object.entries(KNOWLEDGE_TYPES).map(([key, label]) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <Label>公開範囲</Label>
                      <select
                        value={form.visibility}
                        onChange={(e) => setForm({ ...form, visibility: e.target.value })}
                        className={nativeSelectClass}
                      >
                        {Object.entries(VISIBILITIES).map(([key, label]) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>背景</Label>
                    <textarea
                      className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={form.background}
                      onChange={(e) => setForm({ ...form, background: e.target.value })}
                      rows={3}
                      maxLength={2000}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>内容</Label>
                    <textarea
                      className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={form.content}
                      onChange={(e) => setForm({ ...form, content: e.target.value })}
                      rows={5}
                      maxLength={5000}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>結果</Label>
                    <textarea
                      className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={form.result}
                      onChange={(e) => setForm({ ...form, result: e.target.value })}
                      rows={3}
                      maxLength={3000}
                      required
                    />
                  </div>
                  {/*
                    PR #65 Phase 2 (b): ナレッジのタグ入力 (カンマ区切り)。
                    未来のプロジェクトからの類似検索に使われる重要な軸なので、
                    作成時に入力を強く推奨する。
                  */}
                  <div className="space-y-2">
                    <Label>業務ドメインタグ <span className="text-xs text-muted-foreground">(カンマ or 読点「、」で区切り、提案精度向上のため推奨)</span></Label>
                    <Input
                      value={form.businessDomainTagsInput}
                      onChange={(e) => setForm({ ...form, businessDomainTagsInput: e.target.value })}
                      placeholder="例: 金融, 基幹業務, 会計"
                      maxLength={500}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>技術スタックタグ <span className="text-xs text-muted-foreground">(カンマ or 読点「、」で区切り、提案精度向上のため推奨)</span></Label>
                    <Input
                      value={form.techTagsInput}
                      onChange={(e) => setForm({ ...form, techTagsInput: e.target.value })}
                      placeholder="例: React, Next.js, TypeScript"
                      maxLength={500}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>工程タグ <span className="text-xs text-muted-foreground">(カンマ or 読点「、」で区切り、提案精度向上のため推奨)</span></Label>
                    <Input
                      value={form.processTagsInput}
                      onChange={(e) => setForm({ ...form, processTagsInput: e.target.value })}
                      placeholder="例: 要件定義, 設計, 開発, 試験"
                      maxLength={500}
                    />
                  </div>
                  {/* PR #67: 作成と同時に参考リンク等の URL を登録可能 */}
                  <StagedAttachmentsInput
                    value={stagedCreateAttachments}
                    onChange={setStagedCreateAttachments}
                    label="参考リンク"
                  />
                  <Button type="submit" className="w-full">作成</Button>
                </form>
              </DialogContent>
            </Dialog>
          )}
      </div>

      {knowledges.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">ナレッジがありません</p>
      ) : (
        <div className="space-y-2">
          {knowledges.map((k) => {
            // 2026-04-24: 作成者本人のみ編集/削除可 (admin は全ナレッジから)
            const isOwner = k.createdBy === currentUserId;
            return (
            <div
              key={k.id}
              // 2026-04-24: 行クリック編集は作成者本人のみ active
              className={`rounded border p-3 ${isOwner ? 'cursor-pointer hover:bg-muted' : ''}`}
              onClick={isOwner ? () => setEditingKnowledge(k) : undefined}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{k.title}</span>
                    <Badge variant="secondary" className="text-xs">
                      {KNOWLEDGE_TYPES[k.knowledgeType as keyof typeof KNOWLEDGE_TYPES] || k.knowledgeType}
                    </Badge>
                    <Badge variant={visibilityColors[k.visibility] || 'outline'} className="text-xs">
                      {VISIBILITIES[k.visibility as keyof typeof VISIBILITIES] || k.visibility}
                    </Badge>
                    {k.creatorName && (
                      <span className="text-xs text-muted-foreground">作成: {k.creatorName}</span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground line-clamp-2">{k.content}</p>
                </div>
                {isOwner && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive hover:text-destructive"
                    title="削除"
                    aria-label="削除"
                    onClick={(e) => { e.stopPropagation(); handleDelete(k.id); }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
            );
          })}
        </div>
      )}

      <KnowledgeEditDialog
        knowledge={editingKnowledge}
        projectId={projectId}
        open={editingKnowledge != null}
        onOpenChange={(v) => { if (!v) setEditingKnowledge(null); }}
        onSaved={async () => { await onReload(); }}
      />
    </div>
  );
}

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  ResizableColumnsProvider,
  ResizableHead,
  ResetColumnsButton,
} from '@/components/ui/resizable-columns';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { PROJECT_STATUSES, DEV_METHODS } from '@/types';
import type { ProjectDTO } from '@/services/project.service';
import { DateFieldWithActions } from '@/components/ui/date-field-with-actions';
import {
  StagedAttachmentsInput,
  persistStagedAttachments,
  type StagedAttachment,
} from '@/components/attachments/staged-attachments-input';

type Props = {
  initialProjects: ProjectDTO[];
  initialTotal: number;
  isAdmin: boolean;
};

const statusColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  planning: 'outline',
  estimating: 'outline',
  scheduling: 'secondary',
  executing: 'default',
  completed: 'secondary',
  retrospected: 'secondary',
  closed: 'destructive',
};

export function ProjectsClient({ initialProjects, initialTotal, isAdmin }: Props) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    name: '',
    customerName: '',
    purpose: '',
    background: '',
    scope: '',
    devMethod: 'scratch',
    plannedStartDate: '',
    plannedEndDate: '',
    // PR #65: 核心機能 (提案型サービス) のタグ入力。カンマ区切り文字列で受け取り、
    // 送信時に string[] へ変換する。空要素は除外。
    businessDomainTagsInput: '',
    techStackTagsInput: '',
    processTagsInput: '',
  });

  // カンマ区切り文字列を string[] に正規化する (余計な空白除去・空要素除外)
  const parseTagsInput = (s: string): string[] =>
    s.split(',').map((t) => t.trim()).filter((t) => t.length > 0);

  // PR #67: 作成ダイアログで入力された添付 URL を staging。
  // プロジェクト作成成功後に entityId を使って一括 POST する。
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>([]);

  async function handleSearch() {
    const params = new URLSearchParams();
    if (keyword) params.set('keyword', keyword);
    if (statusFilter) params.set('status', statusFilter);
    router.push(`/projects?${params.toString()}`);
    router.refresh();
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    // タグは入力欄の生文字列 (form.*TagsInput) をカンマ分割して送信する
    const payload = {
      name: form.name,
      customerName: form.customerName,
      purpose: form.purpose,
      background: form.background,
      scope: form.scope,
      devMethod: form.devMethod,
      plannedStartDate: form.plannedStartDate,
      plannedEndDate: form.plannedEndDate,
      businessDomainTags: parseTagsInput(form.businessDomainTagsInput),
      techStackTags: parseTagsInput(form.techStackTagsInput),
      processTags: parseTagsInput(form.processTagsInput),
    };

    const res = await withLoading(() =>
      fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );

    if (!res.ok) {
      const json = await res.json();
      setError(json.error?.message || json.error?.details?.[0]?.message || '作成に失敗しました');
      return;
    }

    const json = await res.json();

    // PR #67: 作成成功直後にステージされた添付を一括 POST
    if (stagedAttachments.length > 0 && json.data?.id) {
      await persistStagedAttachments({
        entityType: 'project',
        entityId: json.data.id,
        items: stagedAttachments,
      });
    }
    setStagedAttachments([]);

    setIsCreateOpen(false);
    setForm({
      name: '',
      customerName: '',
      purpose: '',
      background: '',
      scope: '',
      devMethod: 'scratch',
      plannedStartDate: '',
      plannedEndDate: '',
      businessDomainTagsInput: '',
      techStackTagsInput: '',
      processTagsInput: '',
    });
    // PR #65: 新規作成直後は ?suggestions=1 を付けて遷移、詳細画面側で提案モーダルを表示
    router.push(`/projects/${json.data.id}?suggestions=1`);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">プロジェクト一覧</h2>
        {isAdmin && (
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">新規プロジェクト</DialogTrigger>
            <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>新規プロジェクト作成</DialogTitle>
                <DialogDescription>プロジェクトの基本情報を入力してください。</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4">
                {error && (
                  <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
                )}
                <div className="space-y-2">
                  <Label>プロジェクト名</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    maxLength={100}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label>顧客名</Label>
                  <Input
                    value={form.customerName}
                    onChange={(e) => setForm({ ...form, customerName: e.target.value })}
                    maxLength={100}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label>目的</Label>
                  <textarea
                    className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={form.purpose}
                    onChange={(e) => setForm({ ...form, purpose: e.target.value })}
                    rows={3}
                    maxLength={2000}
                    required
                  />
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
                  <Label>スコープ</Label>
                  <textarea
                    className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={form.scope}
                    onChange={(e) => setForm({ ...form, scope: e.target.value })}
                    rows={3}
                    maxLength={2000}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label>開発方式</Label>
                  <select value={form.devMethod} onChange={(e) => setForm({ ...form, devMethod: e.target.value })} className={nativeSelectClass}>
                    {Object.entries(DEV_METHODS).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>開始予定日</Label>
                    <DateFieldWithActions
                      value={form.plannedStartDate}
                      onChange={(v) => setForm({ ...form, plannedStartDate: v })}
                      required
                      hideClear
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>終了予定日</Label>
                    <DateFieldWithActions
                      value={form.plannedEndDate}
                      onChange={(v) => setForm({ ...form, plannedEndDate: v })}
                      required
                      hideClear
                    />
                  </div>
                </div>
                {/*
                  PR #65: 提案型サービス (核心機能) のためのタグ入力。
                  新規プロジェクトと過去ナレッジ/課題のマッチングに利用される。
                  カンマ区切りで入力 (例: "React, Next.js, TypeScript")
                  抜け漏れなく提案を出すため、可能な限り入力を推奨する。
                */}
                <div className="space-y-2">
                  <Label>業務ドメインタグ <span className="text-xs text-muted-foreground">(カンマ区切り、提案精度向上のため推奨)</span></Label>
                  <Input
                    value={form.businessDomainTagsInput}
                    onChange={(e) => setForm({ ...form, businessDomainTagsInput: e.target.value })}
                    placeholder="例: 金融, 基幹業務, 会計"
                    maxLength={500}
                  />
                </div>
                <div className="space-y-2">
                  <Label>技術スタックタグ <span className="text-xs text-muted-foreground">(カンマ区切り、提案精度向上のため推奨)</span></Label>
                  <Input
                    value={form.techStackTagsInput}
                    onChange={(e) => setForm({ ...form, techStackTagsInput: e.target.value })}
                    placeholder="例: React, Next.js, TypeScript, PostgreSQL"
                    maxLength={500}
                  />
                </div>
                <div className="space-y-2">
                  <Label>工程タグ <span className="text-xs text-muted-foreground">(カンマ区切り、提案精度向上のため推奨)</span></Label>
                  <Input
                    value={form.processTagsInput}
                    onChange={(e) => setForm({ ...form, processTagsInput: e.target.value })}
                    placeholder="例: 要件定義, 設計, 開発, 試験"
                    maxLength={500}
                  />
                </div>
                {/* PR #67: 作成と同時に関連 URL を登録可能 */}
                <StagedAttachmentsInput
                  value={stagedAttachments}
                  onChange={setStagedAttachments}
                />
                <Button type="submit" className="w-full">
                  作成
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {/* 検索・フィルタ */}
      <div className="flex gap-4">
        <Input
          placeholder="キーワード検索..."
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          className="max-w-xs"
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? '')}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="全ステータス" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">全ステータス</SelectItem>
            {Object.entries(PROJECT_STATUSES).map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={handleSearch}>
          検索
        </Button>
      </div>

      {/* 一覧テーブル */}
      <ResizableColumnsProvider tableKey="projects">
        <div className="flex justify-end pb-2">
          <ResetColumnsButton />
        </div>
      <Table>
        <TableHeader>
          <TableRow>
            <ResizableHead columnKey="name" defaultWidth={220}>プロジェクト名</ResizableHead>
            <ResizableHead columnKey="customerName" defaultWidth={160}>顧客名</ResizableHead>
            <ResizableHead columnKey="devMethod" defaultWidth={140}>開発方式</ResizableHead>
            <ResizableHead columnKey="status" defaultWidth={110}>ステータス</ResizableHead>
            <ResizableHead columnKey="plannedStartDate" defaultWidth={120}>開始予定日</ResizableHead>
            <ResizableHead columnKey="plannedEndDate" defaultWidth={120}>終了予定日</ResizableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {initialProjects.map((project) => (
            <TableRow key={project.id}>
              <TableCell>
                <Link
                  href={`/projects/${project.id}`}
                  className="font-medium text-info hover:underline"
                >
                  {project.name}
                </Link>
              </TableCell>
              <TableCell>{project.customerName}</TableCell>
              <TableCell>
                {DEV_METHODS[project.devMethod as keyof typeof DEV_METHODS] || project.devMethod}
              </TableCell>
              <TableCell>
                <Badge variant={statusColors[project.status] || 'secondary'}>
                  {PROJECT_STATUSES[project.status as keyof typeof PROJECT_STATUSES] ||
                    project.status}
                </Badge>
              </TableCell>
              <TableCell>{project.plannedStartDate}</TableCell>
              <TableCell>{project.plannedEndDate}</TableCell>
            </TableRow>
          ))}
          {initialProjects.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                プロジェクトがありません
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      </ResizableColumnsProvider>
      {initialTotal > 20 && (
        <p className="text-sm text-muted-foreground">全 {initialTotal} 件中 20 件を表示</p>
      )}
    </div>
  );
}

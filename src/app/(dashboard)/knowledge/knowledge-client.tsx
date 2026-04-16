'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { KNOWLEDGE_TYPES, VISIBILITIES } from '@/types';
import type { KnowledgeDTO } from '@/services/knowledge.service';

type Props = {
  initialKnowledge: KnowledgeDTO[];
  initialTotal: number;
  systemRole: string;
};

const visibilityColors: Record<string, 'default' | 'secondary' | 'outline'> = {
  draft: 'outline',
  project: 'secondary',
  company: 'default',
};

export function KnowledgeClient({ initialKnowledge, initialTotal }: Props) {
  const router = useRouter();
  const { withLoading } = useLoading();
  const [keyword, setKeyword] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    title: '',
    knowledgeType: 'research',
    background: '',
    content: '',
    result: '',
    visibility: 'draft',
  });

  async function handleSearch() {
    const params = new URLSearchParams();
    if (keyword) params.set('keyword', keyword);
    if (typeFilter) params.set('knowledgeType', typeFilter);
    router.push(`/knowledge?${params.toString()}`);
    router.refresh();
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const res = await withLoading(() =>
      fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      }),
    );

    if (!res.ok) {
      const json = await res.json();
      setError(json.error?.message || json.error?.details?.[0]?.message || '作成に失敗しました');
      return;
    }

    setIsCreateOpen(false);
    setForm({
      title: '',
      knowledgeType: 'research',
      background: '',
      content: '',
      result: '',
      visibility: 'draft',
    });
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">ナレッジ</h2>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">ナレッジ作成</DialogTrigger>
          <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>ナレッジ作成</DialogTitle>
              <DialogDescription>知見を記録してください。</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              {error && (
                <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>
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
                  <select value={form.knowledgeType} onChange={(e) => setForm({ ...form, knowledgeType: e.target.value })} className="flex h-8 w-full items-center rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
                    {Object.entries(KNOWLEDGE_TYPES).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>公開範囲</Label>
                  <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })} className="flex h-8 w-full items-center rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
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
              <Button type="submit" className="w-full">
                作成
              </Button>
            </form>
          </DialogContent>
        </Dialog>
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
        <Button variant="outline" onClick={handleSearch}>
          検索
        </Button>
      </div>

      {/* 一覧 */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>タイトル</TableHead>
            <TableHead>種別</TableHead>
            <TableHead>公開範囲</TableHead>
            <TableHead>作成者</TableHead>
            <TableHead>作成日</TableHead>
            <TableHead>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {initialKnowledge.map((k) => (
            <TableRow key={k.id}>
              <TableCell>
                <Link
                  href={`/knowledge/${k.id}`}
                  className="font-medium text-blue-600 hover:underline"
                >
                  {k.title}
                </Link>
              </TableCell>
              <TableCell>
                <Badge variant="secondary">
                  {KNOWLEDGE_TYPES[k.knowledgeType as keyof typeof KNOWLEDGE_TYPES] ||
                    k.knowledgeType}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant={visibilityColors[k.visibility] || 'outline'}>
                  {VISIBILITIES[k.visibility as keyof typeof VISIBILITIES] || k.visibility}
                </Badge>
              </TableCell>
              <TableCell>{k.creatorName || '-'}</TableCell>
              <TableCell>{new Date(k.createdAt).toLocaleDateString('ja-JP')}</TableCell>
              <TableCell>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-600"
                  onClick={async () => {
                    if (!confirm('このナレッジを削除しますか？')) return;
                    await withLoading(() =>
                      fetch(`/api/knowledge/${k.id}`, { method: 'DELETE' }),
                    );
                    router.refresh();
                  }}
                >
                  削除
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {initialKnowledge.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-8 text-center text-gray-500">
                ナレッジがありません
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {initialTotal > 20 && (
        <p className="text-sm text-gray-500">全 {initialTotal} 件中 20 件を表示</p>
      )}
    </div>
  );
}

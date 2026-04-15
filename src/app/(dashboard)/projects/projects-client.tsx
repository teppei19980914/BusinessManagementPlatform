'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLoading } from '@/components/loading-overlay';
import { Button } from '@/components/ui/button';
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
  });

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

    const res = await withLoading(() =>
      fetch('/api/projects', {
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

    const json = await res.json();
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
    });
    router.push(`/projects/${json.data.id}`);
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
                  <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>
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
                  <Select
                    value={form.devMethod}
                    onValueChange={(v) => v && setForm({ ...form, devMethod: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(DEV_METHODS).map(([key, label]) => (
                        <SelectItem key={key} value={key}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>開始予定日</Label>
                    <Input
                      type="date"
                      value={form.plannedStartDate}
                      onChange={(e) => setForm({ ...form, plannedStartDate: e.target.value })}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>終了予定日</Label>
                    <Input
                      type="date"
                      value={form.plannedEndDate}
                      onChange={(e) => setForm({ ...form, plannedEndDate: e.target.value })}
                      required
                    />
                  </div>
                </div>
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
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>プロジェクト名</TableHead>
            <TableHead>顧客名</TableHead>
            <TableHead>開発方式</TableHead>
            <TableHead>ステータス</TableHead>
            <TableHead>開始予定日</TableHead>
            <TableHead>終了予定日</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {initialProjects.map((project) => (
            <TableRow key={project.id}>
              <TableCell>
                <Link
                  href={`/projects/${project.id}`}
                  className="font-medium text-blue-600 hover:underline"
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
              <TableCell colSpan={6} className="py-8 text-center text-gray-500">
                プロジェクトがありません
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

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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

  async function handleSearch() {
    const params = new URLSearchParams();
    if (keyword) params.set('keyword', keyword);
    if (typeFilter) params.set('knowledgeType', typeFilter);
    router.push(`/knowledge?${params.toString()}`);
    router.refresh();
  }

  // PR #54: 作成はプロジェクト詳細「ナレッジ一覧」タブ経由のみ許可する方針に変更
  // (ナレッジは必ずプロジェクトに紐づく必要があるため、ここからの作成は削除)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">全ナレッジ</h2>
        {/*
          作成ボタン廃止 (PR #54):
            ナレッジは必ずプロジェクトに紐づく必要があるため、作成は
            プロジェクト詳細「ナレッジ一覧」タブ経由のみに限定する。
        */}
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
              {/*
                PR #54: タイトルからのリンクを廃止
                  /knowledge/[id] 詳細画面は存在しないため 404 になるバグを解消。
                  Req 4 (PR #55) で「プロジェクト」列にリンクを移設する予定。
              */}
              <TableCell className="font-medium">{k.title}</TableCell>
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
                {/*
                  削除は admin のみ (API 側で enforce 済)。非 admin が押しても 403 で弾かれる。
                  将来的に admin 以外では非表示にする UX 改善を検討 (Req 9 の編集ポップアップと併せて)。
                */}
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

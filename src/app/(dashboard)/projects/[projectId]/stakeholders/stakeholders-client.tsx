'use client';

/**
 * ステークホルダー画面 (PMBOK 13) のクライアントコンポーネント。
 *
 * 役割:
 *   - 一覧表示 (影響度 desc → 関心度 desc)
 *   - Power/Interest grid 4 象限の可視化 (上段) + 一覧テーブル (下段)
 *   - 新規登録ボタン + 行クリックで編集ダイアログ
 *   - Engagement Gap が 0 でないステークホルダーをハイライト (働きかけ必要)
 *
 * 認可:
 *   このコンポーネントは PM/TL + admin のみが到達できる前提
 *   (project-detail-client 側でタブ自体を非表示にしている)。
 *
 * 関連: SPECIFICATION.md / DESIGN.md (ステークホルダー管理)
 */

import { useCallback, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useLoading } from '@/components/loading-overlay';
import {
  Table, TableBody, TableCell, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  ResizableColumnsProvider,
  ResizableHead,
  ResetColumnsButton,
} from '@/components/ui/resizable-columns';
import { StakeholderEditDialog } from '@/components/dialogs/stakeholder-edit-dialog';
import {
  STAKEHOLDER_ATTITUDES,
  STAKEHOLDER_ENGAGEMENTS,
  STAKEHOLDER_QUADRANTS,
  type StakeholderQuadrant,
} from '@/config/master-data';
import type { StakeholderDTO } from '@/services/stakeholder.service';
import type { MemberDTO } from '@/services/member.service';

const ATTITUDE_BADGE_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  supportive: 'default',
  neutral: 'outline',
  opposing: 'destructive',
};

const QUADRANT_DESCRIPTIONS: Record<StakeholderQuadrant, string> = {
  manage_closely: '影響大 × 関心大: 密接に連携し満足させる (定期 1on1 / 重要意思決定への参加)',
  keep_satisfied: '影響大 × 関心小: 満足させておく (方向性に影響しない範囲で必要十分な情報提供)',
  keep_informed: '影響小 × 関心大: 常に情報を伝える (現場意見の聴取で問題早期発見)',
  monitor: '影響小 × 関心小: モニタリング (必要最小限のコミュニケーション)',
};

const QUADRANT_ORDER: StakeholderQuadrant[] = [
  'manage_closely',
  'keep_satisfied',
  'keep_informed',
  'monitor',
];

const QUADRANT_BG: Record<StakeholderQuadrant, string> = {
  manage_closely: 'bg-destructive/10 border-destructive/40',
  keep_satisfied: 'bg-warning/10 border-warning/40',
  keep_informed: 'bg-info/10 border-info/40',
  monitor: 'bg-muted/50 border-muted-foreground/20',
};

type Props = {
  projectId: string;
  stakeholders: StakeholderDTO[];
  members: MemberDTO[];
  onReload: () => Promise<void> | void;
};

export function StakeholdersClient({ projectId, stakeholders, members, onReload }: Props) {
  const { withLoading } = useLoading();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editing, setEditing] = useState<StakeholderDTO | null>(null);

  const reload = useCallback(async () => {
    await onReload();
  }, [onReload]);

  // 4 象限ごとにグルーピング (matrix 描画用)
  const byQuadrant: Record<StakeholderQuadrant, StakeholderDTO[]> = {
    manage_closely: [],
    keep_satisfied: [],
    keep_informed: [],
    monitor: [],
  };
  for (const s of stakeholders) byQuadrant[s.quadrant].push(s);

  const gapCount = stakeholders.filter((s) => s.engagementGap !== 0).length;

  async function handleDelete(s: StakeholderDTO) {
    if (!confirm(`「${s.name}」をステークホルダー一覧から削除しますか？`)) return;
    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/stakeholders/${s.id}`, { method: 'DELETE' }),
    );
    if (!res.ok) {
      alert('削除に失敗しました');
      return;
    }
    await reload();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold">ステークホルダー管理簿</h2>
          <p className="text-xs text-muted-foreground">
            {stakeholders.length} 件
            {gapCount > 0 && (
              <span className="ml-2 text-warning">
                / エンゲージメント Gap あり: {gapCount} 件 (能動的な働きかけ推奨)
              </span>
            )}
          </p>
        </div>
        <Button
          onClick={() => setIsCreateOpen(true)}
          className="shrink-0"
        >
          新規登録
        </Button>
      </div>

      {/* Power/Interest grid 4 象限 ヒートマップ */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {QUADRANT_ORDER.map((q) => (
          <div
            key={q}
            className={`rounded-lg border p-3 ${QUADRANT_BG[q]}`}
          >
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">{STAKEHOLDER_QUADRANTS[q]}</h3>
              <span className="text-xs text-muted-foreground">{byQuadrant[q].length} 名</span>
            </div>
            <p className="mb-2 text-xs text-muted-foreground">{QUADRANT_DESCRIPTIONS[q]}</p>
            <ul className="space-y-1">
              {byQuadrant[q].map((s) => (
                <li key={s.id} className="flex items-center gap-2 text-sm">
                  <button
                    type="button"
                    onClick={() => setEditing(s)}
                    className="flex-1 truncate text-left hover:underline"
                  >
                    {s.name}
                    {s.organization && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({s.organization})
                      </span>
                    )}
                  </button>
                  <Badge
                    variant={ATTITUDE_BADGE_VARIANT[s.attitude] ?? 'outline'}
                    className="shrink-0 text-xs"
                  >
                    {STAKEHOLDER_ATTITUDES[s.attitude]}
                  </Badge>
                </li>
              ))}
              {byQuadrant[q].length === 0 && (
                <li className="text-xs text-muted-foreground">該当者なし</li>
              )}
            </ul>
          </div>
        ))}
      </div>

      {/* 一覧テーブル */}
      <ResizableColumnsProvider tableKey="project-stakeholders">
        <div className="flex justify-end pb-2">
          <ResetColumnsButton />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <ResizableHead columnKey="name" defaultWidth={160}>氏名</ResizableHead>
              <ResizableHead columnKey="organization" defaultWidth={140}>所属</ResizableHead>
              <ResizableHead columnKey="role" defaultWidth={100}>役職</ResizableHead>
              <ResizableHead columnKey="influence" defaultWidth={70}>影響度</ResizableHead>
              <ResizableHead columnKey="interest" defaultWidth={70}>関心度</ResizableHead>
              <ResizableHead columnKey="attitude" defaultWidth={70}>姿勢</ResizableHead>
              <ResizableHead columnKey="engagement" defaultWidth={140}>現在 → 望ましい</ResizableHead>
              <ResizableHead columnKey="gap" defaultWidth={60}>Gap</ResizableHead>
              <ResizableHead columnKey="actions" defaultWidth={70}>操作</ResizableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stakeholders.map((s) => (
              <TableRow
                key={s.id}
                className="cursor-pointer hover:bg-muted"
                onClick={() => setEditing(s)}
              >
                <TableCell className="font-medium">
                  {s.name}
                  {s.userId && (
                    <span className="ml-1 text-xs text-info">(内部)</span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {s.organization || '-'}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{s.role || '-'}</TableCell>
                <TableCell>{s.influence}</TableCell>
                <TableCell>{s.interest}</TableCell>
                <TableCell>
                  <Badge variant={ATTITUDE_BADGE_VARIANT[s.attitude] ?? 'outline'}>
                    {STAKEHOLDER_ATTITUDES[s.attitude]}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">
                  {STAKEHOLDER_ENGAGEMENTS[s.currentEngagement]}
                  <span className="mx-1 text-muted-foreground">→</span>
                  {STAKEHOLDER_ENGAGEMENTS[s.desiredEngagement]}
                </TableCell>
                <TableCell>
                  {s.engagementGap === 0 ? (
                    <Badge variant="outline">0</Badge>
                  ) : (
                    <Badge variant={s.engagementGap > 0 ? 'default' : 'secondary'}>
                      {s.engagementGap > 0 ? `+${s.engagementGap}` : s.engagementGap}
                    </Badge>
                  )}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={() => handleDelete(s)}
                  >
                    削除
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {stakeholders.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  ステークホルダーがまだ登録されていません。右上の「新規登録」から追加してください。
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ResizableColumnsProvider>

      <StakeholderEditDialog
        projectId={projectId}
        stakeholder={null}
        members={members}
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onSaved={reload}
      />
      <StakeholderEditDialog
        projectId={projectId}
        stakeholder={editing}
        members={members}
        open={editing != null}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        onSaved={reload}
      />
    </div>
  );
}

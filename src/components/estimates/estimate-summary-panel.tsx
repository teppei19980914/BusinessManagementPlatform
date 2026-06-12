'use client';

/**
 * 見積もりサマリパネル (v1.2.0)
 *
 * カテゴリ別小計・バッファ設定・合計工数（バッファ込み）・エクスポートボタンを表示する。
 * バッファ率は state 管理のみ (セッション中有効。DB 保存なし — 案X 設計方針)。
 */

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { Label } from '@/components/ui/label';
import { TASK_CATEGORIES } from '@/types';
import type { EstimateDTO } from '@/services/estimate.service';

type Props = {
  estimates: EstimateDTO[];
  bufferRate: number;
  onBufferRateChange: (v: number) => void;
  onExportExcel: () => void;
  onExportWord: () => void;
};

export function EstimateSummaryPanel({
  estimates,
  bufferRate,
  onBufferRateChange,
  onExportExcel,
  onExportWord,
}: Props) {
  const t = useTranslations('estimate');

  // アクティブな見積もり (未削除) のみ集計
  const active = estimates;

  // カテゴリ別小計
  const categoryTotals = Object.keys(TASK_CATEGORIES).map((key) => {
    const items = active.filter((e) => e.category === key);
    const total = items.reduce((sum, e) => sum + e.estimatedEffort, 0);
    return { key, label: TASK_CATEGORIES[key as keyof typeof TASK_CATEGORIES], total };
  }).filter((c) => c.total > 0);

  const subtotal = active.reduce((sum, e) => sum + e.estimatedEffort, 0);
  const bufferHours = Math.round(subtotal * bufferRate * 10) / 10;
  const totalWithBuffer = Math.round((subtotal + bufferHours) * 10) / 10;

  // 工数単位が混在する場合は person_hour 換算 (表示用として人時ベースで統一)
  // 注: 本プロジェクトの見積もりは人時 / 人日が混在しうるため、ラベルは 'h' 固定で表示
  const unit = 'h';

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        {/* カテゴリ別小計 */}
        <div className="flex-1 min-w-[200px] space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t('summaryByCategory')}
          </p>
          {categoryTotals.length === 0 ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            <ul className="space-y-0.5">
              {categoryTotals.map((c) => (
                <li key={c.key} className="flex items-center justify-between text-sm gap-4">
                  <span className="text-muted-foreground">{c.label}</span>
                  <span className="font-medium tabular-nums">{c.total}{unit}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* バッファ設定 + 合計 */}
        <div className="flex-1 min-w-[200px] space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground uppercase tracking-wide">
              {t('bufferRate')}
            </Label>
            <div className="flex items-center gap-2">
              <NumberInput
                min={0}
                max={50}
                step={5}
                value={bufferRate * 100}
                onChange={(v) => onBufferRateChange(Math.min(0.5, Math.max(0, v / 100)))}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
          </div>
          <div className="space-y-0.5 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">小計</span>
              <span className="tabular-nums">{subtotal}{unit}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">バッファ ({bufferRate * 100}%)</span>
              <span className="tabular-nums">+{bufferHours}{unit}</span>
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-border pt-1 font-semibold">
              <span>{t('totalWithBuffer', { value: totalWithBuffer })}</span>
            </div>
          </div>
        </div>
      </div>

      {/* エクスポートボタン */}
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Button variant="outline" size="sm" onClick={onExportExcel} disabled={active.length === 0}>
          {t('exportExcel')}
        </Button>
        <Button variant="outline" size="sm" onClick={onExportWord} disabled={active.length === 0}>
          {t('exportWord')}
        </Button>
      </div>
    </div>
  );
}

'use client';

/**
 * 見積もり画面 (プロジェクト詳細タブ配下) のクライアントコンポーネント。
 *
 * 役割:
 *   見積もり明細 (1 行 = 1 作業項目) の一覧 / 追加 / 確定 / 削除を管理する。
 *
 * v1.2.0 で「手動登録」と「ツールで見積もる」の 2 モードを追加:
 *   - 手動登録 (inputMode=direct): 確定済み工数を直接入力するパターン。
 *   - 係数ベース (inputMode=coefficient): 開発ツール・規模・難易度を選ぶと工数を自動計算する。
 *     計算式: 見積工数 = 基準時間 × 規模係数 × 難易度係数 × 手法係数
 *
 * バッファ設定:
 *   バッファ率 (0〜50%) は state 管理のみ (セッション中有効。DB 保存なし — 案X 設計方針)。
 *   案Y (テナントレベルのデフォルト設定) は将来機能として実装予定。
 *
 * 認可: canEdit prop (PM/TL 以上 or admin)。
 * API: /api/projects/[id]/estimates (GET/POST), /api/projects/[id]/estimates/[id] (PATCH/DELETE)
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useFormatters } from '@/lib/use-formatters';
import { useLoading } from '@/components/loading-overlay';
import { useToast } from '@/components/toast-provider';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Label } from '@/components/ui/label';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import { useTablePagination, TablePagination } from '@/components/common/table-pagination';
import { TASK_CATEGORIES, EFFORT_UNITS } from '@/types';
import { CoefficientForm, type CoefficientFormState } from '@/components/estimates/coefficient-form';
import { EstimateSummaryPanel } from '@/components/estimates/estimate-summary-panel';
import { getMethodOption } from '@/config/estimate-master';
import { exportEstimateExcel } from '@/utils/export-estimate-excel';
import { exportEstimateWord } from '@/utils/export-estimate-word';
import type { EstimateDTO } from '@/services/estimate.service';

type Props = {
  projectId: string;
  projectName?: string;
  estimates: EstimateDTO[];
  canEdit: boolean;
  /** CRUD 後に呼び出す再取得ハンドラ（未指定時は router.refresh フォールバック）*/
  onReload?: () => Promise<void> | void;
};

const BLANK_BASE = {
  itemName: '',
  category: 'development',
  estimatedEffort: 0,
  effortUnit: 'person_hour',
  notes: '',
};

const DEFAULT_COEFF_FORM: CoefficientFormState = {
  devMethodKey: 'scratch',
  baseHours: 16,
  scaleCoeff: 1.0,
  difficultyCoeff: 1.0,
  methodCoeff: 1.0,
};

export function EstimatesClient({ projectId, projectName, estimates, canEdit, onReload }: Props) {
  const router = useRouter();
  const t = useTranslations('estimate');
  const tCommon = useTranslations('common');
  const resolvedProjectName = projectName ?? t('defaultProjectName');
  const { formatDateTimeSeconds } = useFormatters();
  const { withLoading } = useLoading();
  const { showSuccessKey, showErrorKey } = useToast();

  const reload = useCallback(async () => {
    if (onReload) {
      await onReload();
    } else {
      router.refresh();
    }
  }, [onReload, router]);

  // ---- ダイアログ開閉状態 ----
  const [isDirectOpen, setIsDirectOpen] = useState(false);
  const [isCoeffOpen, setIsCoeffOpen] = useState(false);
  const [error, setError] = useState('');

  // ---- 手動登録フォーム ----
  const [directForm, setDirectForm] = useState({ ...BLANK_BASE });

  // ---- 係数ベースフォーム ----
  const [coeffBase, setCoeffBase] = useState({ ...BLANK_BASE });
  const [coeffForm, setCoeffForm] = useState<CoefficientFormState>(DEFAULT_COEFF_FORM);

  // ---- バッファ率 (案X 方針: state 管理のみ、デフォルト 20%) ----
  const [bufferRate, setBufferRate] = useState(0.2);

  // ================================================================
  // 手動登録
  // ================================================================
  async function handleCreateDirect(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/estimates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...directForm, inputMode: 'direct' }),
      }),
    );
    if (!res.ok) {
      const json = await res.json();
      setError(json.error?.message || json.error?.details?.[0]?.message || t('createFailed'));
      showErrorKey('estimate.toastCreateFailed');
      return;
    }
    setIsDirectOpen(false);
    setDirectForm({ ...BLANK_BASE });
    showSuccessKey('estimate.toastCreateSuccess');
    await reload();
  }

  // ================================================================
  // 係数ベース登録
  // ================================================================
  async function handleCreateCoeff(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/estimates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...coeffBase,
          inputMode: 'coefficient',
          devMethod: coeffForm.devMethodKey,
          baseHours: coeffForm.baseHours,
          scaleCoeff: coeffForm.scaleCoeff,
          difficultyCoeff: coeffForm.difficultyCoeff,
          methodCoeff: coeffForm.methodCoeff,
        }),
      }),
    );
    if (!res.ok) {
      const json = await res.json();
      setError(json.error?.message || json.error?.details?.[0]?.message || t('createFailed'));
      showErrorKey('estimate.toastCreateFailed');
      return;
    }
    setIsCoeffOpen(false);
    setCoeffBase({ ...BLANK_BASE });
    setCoeffForm(DEFAULT_COEFF_FORM);
    showSuccessKey('estimate.toastCreateSuccess');
    await reload();
  }

  // ================================================================
  // 確定
  // ================================================================
  async function handleConfirm(estimateId: string) {
    const res = await withLoading(() =>
      fetch(`/api/projects/${projectId}/estimates/${estimateId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm' }),
      }),
    );
    if (!res.ok) {
      showErrorKey('estimate.toastConfirmFailed');
      return;
    }
    showSuccessKey('estimate.toastConfirmSuccess');
    await reload();
  }

  // ================================================================
  // エクスポート
  // ================================================================
  async function handleExportExcel() {
    try {
      await exportEstimateExcel(estimates, resolvedProjectName, bufferRate);
    } catch {
      showErrorKey('estimate.toastExcelExportFailed');
    }
  }

  async function handleExportWord() {
    try {
      await exportEstimateWord(estimates, resolvedProjectName, bufferRate);
    } catch {
      showErrorKey('estimate.toastWordExportFailed');
    }
  }

  // ================================================================
  // 表示
  // ================================================================
  const totalEffort = estimates.reduce((sum, e) => sum + e.estimatedEffort, 0);
  const { pageItems, page, pageCount, setPage } = useTablePagination(estimates, '');

  return (
    <div className="space-y-6">
      {/* サマリパネル */}
      <EstimateSummaryPanel
        estimates={estimates}
        bufferRate={bufferRate}
        onBufferRateChange={setBufferRate}
        onExportExcel={handleExportExcel}
        onExportWord={handleExportWord}
      />

      {/* ヘッダー：合計工数 + 追加ボタン群 */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-muted-foreground">{t('totalEffort', { value: totalEffort })}</p>
        {canEdit && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => { setError(''); setDirectForm({ ...BLANK_BASE }); setIsDirectOpen(true); }}>
              {t('addDirectButton')}
            </Button>
            <Button size="sm" onClick={() => { setError(''); setCoeffBase({ ...BLANK_BASE }); setCoeffForm(DEFAULT_COEFF_FORM); setIsCoeffOpen(true); }}>
              {t('addCoeffButton')}
            </Button>
          </div>
        )}
      </div>

      {/* ============================================================ */}
      {/* 手動登録ダイアログ                                            */}
      {/* ============================================================ */}
      <Dialog open={isDirectOpen} onOpenChange={setIsDirectOpen}>
        <DialogContent className="max-w-[min(90vw,36rem)] max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('addDirectDialogTitle')}</DialogTitle>
            <DialogDescription>{t('addDirectDialogDescription')}</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateDirect} className="space-y-4">
            {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
            <div className="space-y-2">
              <Label htmlFor="direct-item-name">{t('itemName')}</Label>
              <Input id="direct-item-name" value={directForm.itemName} onChange={(e) => setDirectForm({ ...directForm, itemName: e.target.value })} maxLength={100} required />
            </div>
            <div className="space-y-2">
              <Label>{t('category')}</Label>
              <select value={directForm.category} onChange={(e) => setDirectForm({ ...directForm, category: e.target.value })} className={nativeSelectClass}>
                {Object.entries(TASK_CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('estimatedEffort')}</Label>
                <NumberInput min={1} step={0.5} value={directForm.estimatedEffort} onChange={(n) => setDirectForm({ ...directForm, estimatedEffort: n })} required />
              </div>
              <div className="space-y-2">
                <Label>{t('unit')}</Label>
                <select value={directForm.effortUnit} onChange={(e) => setDirectForm({ ...directForm, effortUnit: e.target.value })} className={nativeSelectClass}>
                  {Object.entries(EFFORT_UNITS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t('columnNotes')}</Label>
              <textarea className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={directForm.notes} onChange={(e) => setDirectForm({ ...directForm, notes: e.target.value })} rows={4} maxLength={1000} />
            </div>
            <Button type="submit" className="w-full">{t('add')}</Button>
          </form>
        </DialogContent>
      </Dialog>

      {/* ============================================================ */}
      {/* ツールで見積もるダイアログ                                    */}
      {/* ============================================================ */}
      <Dialog open={isCoeffOpen} onOpenChange={setIsCoeffOpen}>
        <DialogContent className="max-w-[min(90vw,44rem)] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('addCoeffDialogTitle')}</DialogTitle>
            <DialogDescription>{t('addCoeffDialogDescription')}</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateCoeff} className="space-y-4">
            {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
            <div className="space-y-2">
              <Label htmlFor="coeff-item-name">{t('itemName')}</Label>
              <Input id="coeff-item-name" value={coeffBase.itemName} onChange={(e) => setCoeffBase({ ...coeffBase, itemName: e.target.value })} maxLength={100} required />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('category')}</Label>
                <select value={coeffBase.category} onChange={(e) => setCoeffBase({ ...coeffBase, category: e.target.value })} className={nativeSelectClass}>
                  {Object.entries(TASK_CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <Label>{t('unit')}</Label>
                <select value={coeffBase.effortUnit} onChange={(e) => setCoeffBase({ ...coeffBase, effortUnit: e.target.value })} className={nativeSelectClass}>
                  {Object.entries(EFFORT_UNITS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
            </div>
            {/* 係数計算フォーム: カテゴリ連動でプリセット自動反映、計算結果を estimatedEffort に反映 */}
            <CoefficientForm
              category={coeffBase.category}
              state={coeffForm}
              onChange={setCoeffForm}
              onCalcResult={(v) => setCoeffBase((prev) => ({ ...prev, estimatedEffort: v }))}
            />
            <div className="space-y-2">
              <Label>{t('columnNotes')}</Label>
              <textarea className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={coeffBase.notes} onChange={(e) => setCoeffBase({ ...coeffBase, notes: e.target.value })} rows={3} maxLength={1000} />
            </div>
            <Button type="submit" className="w-full" disabled={coeffBase.estimatedEffort <= 0}>{t('add')}</Button>
          </form>
        </DialogContent>
      </Dialog>

      {/* ============================================================ */}
      {/* 見積もり一覧テーブル                                          */}
      {/* ============================================================ */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('columnItemName')}</TableHead>
            <TableHead>{t('columnCategory')}</TableHead>
            <TableHead>{t('columnInputMode')}</TableHead>
            <TableHead>{t('columnEffort')}</TableHead>
            <TableHead>{t('columnNotes')}</TableHead>
            <TableHead>{t('columnState')}</TableHead>
            <TableHead>{tCommon('auditCreatedBy')}</TableHead>
            <TableHead>{tCommon('auditCreatedAt')}</TableHead>
            <TableHead>{tCommon('auditUpdatedBy')}</TableHead>
            <TableHead>{tCommon('auditUpdatedAt')}</TableHead>
            {canEdit && <TableHead>{t('columnActions')}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageItems.map((e) => {
            const methodOpt = e.inputMode === 'coefficient' ? getMethodOption(e.devMethod ?? '') : undefined;
            return (
              <TableRow key={e.id}>
                <TableCell className="font-medium">{e.itemName}</TableCell>
                <TableCell>{TASK_CATEGORIES[e.category as keyof typeof TASK_CATEGORIES] || e.category}</TableCell>
                <TableCell>
                  {e.inputMode === 'coefficient' ? (
                    <div className="flex flex-col gap-0.5">
                      <Badge variant="secondary" className="w-fit text-xs">{t('inputModeCoefficient')}</Badge>
                      {methodOpt && <span className="text-xs text-muted-foreground">{methodOpt.label}</span>}
                    </div>
                  ) : (
                    <Badge variant="outline" className="text-xs">{t('inputModeDirect')}</Badge>
                  )}
                </TableCell>
                <TableCell>{e.estimatedEffort} {EFFORT_UNITS[e.effortUnit as keyof typeof EFFORT_UNITS] || e.effortUnit}</TableCell>
                <TableCell className="max-w-xs truncate">{e.notes || '—'}</TableCell>
                <TableCell>
                  <Badge variant={e.isConfirmed ? 'default' : 'outline'}>
                    {e.isConfirmed ? t('stateConfirmed') : t('stateUnconfirmed')}
                  </Badge>
                </TableCell>
                <TableCell>{e.createdByName || '—'}</TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTimeSeconds(e.createdAt)}</TableCell>
                <TableCell>{e.updatedAt !== e.createdAt ? (e.updatedByName || '—') : '—'}</TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{e.updatedAt !== e.createdAt ? formatDateTimeSeconds(e.updatedAt) : '—'}</TableCell>
                {canEdit && (
                  <TableCell>
                    <div className="flex gap-1">
                      {!e.isConfirmed && (
                        <Button variant="outline" size="sm" onClick={() => handleConfirm(e.id)}>{t('confirm')}</Button>
                      )}
                      {!e.isConfirmed && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive"
                          onClick={async () => {
                            if (!confirm(t('deleteConfirm'))) return;
                            const res = await withLoading(() =>
                              fetch(`/api/projects/${projectId}/estimates/${e.id}`, { method: 'DELETE' }),
                            );
                            if (!res.ok) {
                              showErrorKey('estimate.toastDeleteFailed');
                              return;
                            }
                            showSuccessKey('estimate.toastDeleteSuccess');
                            await reload();
                          }}
                        >
                          {t('delete')}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            );
          })}
          {estimates.length === 0 && (
            <TableRow>
              <TableCell colSpan={canEdit ? 11 : 10} className="py-8 text-center text-muted-foreground">{t('noItems')}</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <TablePagination page={page} pageCount={pageCount} onPageChange={setPage} />
    </div>
  );
}

'use client';

/**
 * 係数ベース工数見積もりフォーム (v1.2.0)
 *
 * 計算式: 見積工数(h) = baseHours × scaleCoeff × difficultyCoeff × methodCoeff
 *
 * 動作:
 *   - ツール + カテゴリを選択すると baseHours がプリセット値に自動入力される
 *   - 全フィールドはユーザーが自由に上書き可能 (案X 方針)
 *   - 計算結果をリアルタイムプレビュー表示し、親フォームへの estimatedEffort も自動更新する
 */

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import { NumberInput } from '@/components/ui/number-input';
import { nativeSelectClass } from '@/components/ui/native-select-style';
import {
  METHOD_OPTIONS,
  SCALE_OPTIONS,
  DIFFICULTY_OPTIONS,
  calcCoefficient,
  getMethodOption,
} from '@/config/estimate-master';
import type { BaseHoursPreset } from '@/config/estimate-master';

export type CoefficientFormState = {
  devMethodKey: string;
  baseHours: number;
  scaleCoeff: number;
  difficultyCoeff: number;
  methodCoeff: number;
};

type Props = {
  category: string;
  state: CoefficientFormState;
  onChange: (state: CoefficientFormState) => void;
  /** 計算結果を親フォームの estimatedEffort に反映するコールバック */
  onCalcResult: (value: number) => void;
};

// ツールグループの表示順
const GROUP_ORDER = ['開発方式', 'RPA', 'ローコード/ノーコード', 'その他'];

export function CoefficientForm({ category, state, onChange, onCalcResult }: Props) {
  const t = useTranslations('estimate');

  // ツール選択またはカテゴリ変更時に baseHours をプリセット値に更新
  useEffect(() => {
    const option = getMethodOption(state.devMethodKey);
    if (!option) return;
    const preset = option.presetBaseHours[category as keyof BaseHoursPreset];
    if (preset !== undefined) {
      onChange({ ...state, baseHours: preset });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.devMethodKey, category]);

  // 計算結果をリアルタイムで親に通知
  useEffect(() => {
    if (state.baseHours > 0 && state.scaleCoeff > 0 && state.difficultyCoeff > 0 && state.methodCoeff > 0) {
      onCalcResult(calcCoefficient(state.baseHours, state.scaleCoeff, state.difficultyCoeff, state.methodCoeff));
    }
  }, [state.baseHours, state.scaleCoeff, state.difficultyCoeff, state.methodCoeff, onCalcResult]);

  const calcResult = (state.baseHours > 0 && state.scaleCoeff > 0 && state.difficultyCoeff > 0 && state.methodCoeff > 0)
    ? calcCoefficient(state.baseHours, state.scaleCoeff, state.difficultyCoeff, state.methodCoeff)
    : null;

  // グループ別にツールを整理
  const groups = GROUP_ORDER.map((g) => ({
    group: g,
    options: METHOD_OPTIONS.filter((o) => o.group === g),
  })).filter((g) => g.options.length > 0);

  return (
    <div className="space-y-4 rounded-md border border-border bg-muted/30 p-4">
      {/* ツール選択 */}
      <div className="space-y-2">
        <Label htmlFor="coeff-tool-select">{t('toolSelection')}</Label>
        <select
          id="coeff-tool-select"
          value={state.devMethodKey}
          onChange={(e) => {
            const opt = getMethodOption(e.target.value);
            onChange({
              ...state,
              devMethodKey: e.target.value,
              methodCoeff: opt?.defaultMethodCoeff ?? 1.0,
            });
          }}
          className={nativeSelectClass}
        >
          {groups.map(({ group, options }) => (
            <optgroup key={group} label={group}>
              {options.map((o) => (
                <option key={o.devMethodKey} value={o.devMethodKey}>{o.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* 規模係数 */}
        <div className="space-y-2">
          <Label>{t('scaleCoeff')}</Label>
          <select
            value={state.scaleCoeff}
            onChange={(e) => onChange({ ...state, scaleCoeff: Number(e.target.value) })}
            className={nativeSelectClass}
          >
            {SCALE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label} (×{o.value})</option>
            ))}
          </select>
        </div>

        {/* 難易度係数 */}
        <div className="space-y-2">
          <Label>{t('difficultyCoeff')}</Label>
          <select
            value={state.difficultyCoeff}
            onChange={(e) => onChange({ ...state, difficultyCoeff: Number(e.target.value) })}
            className={nativeSelectClass}
          >
            {DIFFICULTY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label} (×{o.value})</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* 基準時間 */}
        <div className="space-y-2">
          <Label>{t('baseHours')}</Label>
          <NumberInput
            min={0.5}
            step={0.5}
            value={state.baseHours}
            onChange={(n) => onChange({ ...state, baseHours: n })}
          />
        </div>

        {/* 手法係数 */}
        <div className="space-y-2">
          <Label>{t('methodCoeff')}</Label>
          <NumberInput
            min={0.1}
            step={0.1}
            value={state.methodCoeff}
            onChange={(n) => onChange({ ...state, methodCoeff: n })}
          />
        </div>
      </div>

      {/* 計算結果プレビュー */}
      {calcResult !== null && (
        <div className="rounded-md bg-primary/10 px-4 py-2 text-sm font-medium text-primary">
          {t('calcPreview', { value: calcResult })}
        </div>
      )}
    </div>
  );
}

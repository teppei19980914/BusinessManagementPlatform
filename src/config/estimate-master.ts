/**
 * 工数見積もりツール マスタ定数 (v1.2.0)
 *
 * 計算式: 見積工数(h) = baseHours × scaleCoeff × difficultyCoeff × methodCoeff
 *
 * 設計方針 (案X):
 *   - ツール選択時にカテゴリ別 baseHours を自動入力し、ユーザーが任意編集できる
 *   - methodCoeff はデフォルト 1.0 (ツール間差は baseHours で吸収)
 *   - 全係数値はフォーム上で自由に上書き可能 (理論初期値として機能)
 *
 * 将来機能 (案Y — 未実装):
 *   テナント管理者がこれらのデフォルト値をカスタマイズし DB に保存できる設定画面。
 *   現時点はコード定数のみ。カスタマイズ要件が出た時点で
 *   TenantEstimateSettings テーブルを追加し本ファイルをフォールバックとして残す想定。
 */

import type { DevMethodValue } from '@/lib/validators/estimate';

// ============================================================
// 規模係数
// ============================================================
export type ScaleOption = { label: string; value: number };

export const SCALE_OPTIONS: ScaleOption[] = [
  { label: '極小', value: 0.3 },
  { label: '小',   value: 0.6 },
  { label: '中',   value: 1.0 },
  { label: '大',   value: 1.5 },
  { label: '特大', value: 2.5 },
];

// ============================================================
// 難易度係数
// ============================================================
export type DifficultyOption = { label: string; value: number };

export const DIFFICULTY_OPTIONS: DifficultyOption[] = [
  { label: '低',       value: 0.8 },
  { label: '中',       value: 1.0 },
  { label: '高',       value: 1.3 },
  { label: '非常に高', value: 1.8 },
];

// ============================================================
// 手法オプション (ツール別)
// ============================================================
export type MethodOption = {
  label: string;
  group: string;
  devMethodKey: DevMethodValue;
  defaultMethodCoeff: number;
  presetBaseHours: BaseHoursPreset;
};

// カテゴリ別基準時間プリセット (h/標準作業単位)
export type BaseHoursPreset = {
  requirements: number;
  design: number;
  development: number;
  testing: number;
  review: number;
  management: number;
  other: number;
};

export const METHOD_OPTIONS: MethodOption[] = [
  // ---- スクラッチ / パッケージ ----
  {
    label: 'スクラッチ開発',
    group: '開発方式',
    devMethodKey: 'scratch',
    defaultMethodCoeff: 1.0,
    presetBaseHours: {
      requirements: 8,
      design: 12,
      development: 16,
      testing: 8,
      review: 4,
      management: 4,
      other: 4,
    },
  },
  {
    label: 'パッケージカスタマイズ',
    group: '開発方式',
    devMethodKey: 'package',
    defaultMethodCoeff: 1.0,
    presetBaseHours: {
      requirements: 4,
      design: 6,
      development: 4,
      testing: 4,
      review: 2,
      management: 4,
      other: 4,
    },
  },
  // ---- RPA ----
  {
    label: 'WinActor',
    group: 'RPA',
    devMethodKey: 'winactor',
    defaultMethodCoeff: 1.0,
    presetBaseHours: {
      requirements: 4,
      design: 4,
      development: 4,
      testing: 4,
      review: 2,
      management: 4,
      other: 4,
    },
  },
  {
    label: 'UiPath',
    group: 'RPA',
    devMethodKey: 'uipath',
    defaultMethodCoeff: 1.0,
    presetBaseHours: {
      requirements: 4,
      design: 4,
      development: 3,
      testing: 3,
      review: 2,
      management: 4,
      other: 4,
    },
  },
  {
    label: 'Power Automate Desktop',
    group: 'RPA',
    devMethodKey: 'power_automate_desktop',
    defaultMethodCoeff: 1.0,
    presetBaseHours: {
      requirements: 4,
      design: 4,
      development: 3,
      testing: 3,
      review: 2,
      management: 4,
      other: 4,
    },
  },
  // ---- ローコード/ノーコード ----
  {
    label: 'Power Apps',
    group: 'ローコード/ノーコード',
    devMethodKey: 'power_apps',
    defaultMethodCoeff: 1.0,
    presetBaseHours: {
      requirements: 4,
      design: 6,
      development: 6,
      testing: 4,
      review: 2,
      management: 4,
      other: 4,
    },
  },
  {
    label: 'kintone',
    group: 'ローコード/ノーコード',
    devMethodKey: 'kintone',
    defaultMethodCoeff: 1.0,
    presetBaseHours: {
      requirements: 3,
      design: 4,
      development: 3,
      testing: 2,
      review: 2,
      management: 4,
      other: 4,
    },
  },
  {
    label: 'Pleasanter',
    group: 'ローコード/ノーコード',
    devMethodKey: 'pleasanter',
    defaultMethodCoeff: 1.0,
    presetBaseHours: {
      requirements: 3,
      design: 4,
      development: 4,
      testing: 3,
      review: 2,
      management: 4,
      other: 4,
    },
  },
  {
    label: 'OutSystems',
    group: 'ローコード/ノーコード',
    devMethodKey: 'outsystems',
    defaultMethodCoeff: 1.0,
    presetBaseHours: {
      requirements: 4,
      design: 6,
      development: 5,
      testing: 4,
      review: 2,
      management: 4,
      other: 4,
    },
  },
  {
    label: 'Salesforce (Lightning)',
    group: 'ローコード/ノーコード',
    devMethodKey: 'salesforce_lightning',
    defaultMethodCoeff: 1.0,
    presetBaseHours: {
      requirements: 4,
      design: 8,
      development: 8,
      testing: 5,
      review: 3,
      management: 4,
      other: 4,
    },
  },
  {
    label: 'ServiceNow',
    group: 'ローコード/ノーコード',
    devMethodKey: 'servicenow',
    defaultMethodCoeff: 1.0,
    presetBaseHours: {
      requirements: 4,
      design: 6,
      development: 7,
      testing: 5,
      review: 3,
      management: 4,
      other: 4,
    },
  },
  {
    label: 'Mendix',
    group: 'ローコード/ノーコード',
    devMethodKey: 'mendix',
    defaultMethodCoeff: 1.0,
    presetBaseHours: {
      requirements: 4,
      design: 6,
      development: 5,
      testing: 4,
      review: 2,
      management: 4,
      other: 4,
    },
  },
  {
    label: 'AppSheet',
    group: 'ローコード/ノーコード',
    devMethodKey: 'appsheet',
    defaultMethodCoeff: 1.0,
    presetBaseHours: {
      requirements: 2,
      design: 3,
      development: 2,
      testing: 2,
      review: 1,
      management: 4,
      other: 4,
    },
  },
  {
    label: 'Zoho Creator',
    group: 'ローコード/ノーコード',
    devMethodKey: 'zoho_creator',
    defaultMethodCoeff: 1.0,
    presetBaseHours: {
      requirements: 3,
      design: 4,
      development: 3,
      testing: 2,
      review: 2,
      management: 4,
      other: 4,
    },
  },
  // ---- その他 ----
  {
    label: 'ローコード/ノーコード (その他)',
    group: 'その他',
    devMethodKey: 'low_code_no_code',
    defaultMethodCoeff: 1.0,
    presetBaseHours: {
      requirements: 4,
      design: 6,
      development: 6,
      testing: 4,
      review: 2,
      management: 4,
      other: 4,
    },
  },
  {
    label: 'その他',
    group: 'その他',
    devMethodKey: 'other',
    defaultMethodCoeff: 1.0,
    presetBaseHours: {
      requirements: 6,
      design: 8,
      development: 8,
      testing: 6,
      review: 3,
      management: 4,
      other: 4,
    },
  },
];

// ============================================================
// ユーティリティ
// ============================================================

/** ツールキーから MethodOption を取得 */
export function getMethodOption(devMethodKey: string): MethodOption | undefined {
  return METHOD_OPTIONS.find((o) => o.devMethodKey === devMethodKey);
}

/** 係数計算 */
export function calcCoefficient(
  baseHours: number,
  scaleCoeff: number,
  difficultyCoeff: number,
  methodCoeff: number,
): number {
  return Math.round(baseHours * scaleCoeff * difficultyCoeff * methodCoeff * 10) / 10;
}

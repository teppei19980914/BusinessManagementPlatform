import { z } from 'zod/v4';
import {
  NAME_MAX_LENGTH,
  LONG_TEXT_MAX_LENGTH,
  MEDIUM_TEXT_MAX_LENGTH,
  NOTES_MAX_LENGTH,
} from '@/config';

// v1.2.0: 係数ベース見積もりツール対応
// 入力モード: 'direct' = 手動入力 (既存), 'coefficient' = 係数ベース計算 (新規)
export const ESTIMATE_INPUT_MODES = ['direct', 'coefficient'] as const;
export type EstimateInputMode = (typeof ESTIMATE_INPUT_MODES)[number];

// devMethod: 既存値との後方互換を保ちつつ、v1.2.0 でツール別キーを追加
// 係数ベースモード選択肢と 1:1 対応 (estimate-master.ts の METHOD_OPTIONS.devMethodKey と同一)
export const DEV_METHOD_VALUES = [
  // --- 既存値 (後方互換) ---
  'scratch',
  'low_code_no_code',
  'package',
  'other',
  // --- v1.2.0 追加: RPA ---
  'winactor',
  'uipath',
  'power_automate_desktop',
  // --- v1.2.0 追加: ローコード/ノーコード ---
  'power_apps',
  'kintone',
  'pleasanter',
  'outsystems',
  'salesforce_lightning',
  'servicenow',
  'mendix',
  'appsheet',
  'zoho_creator',
] as const;
export type DevMethodValue = (typeof DEV_METHOD_VALUES)[number];

// category: TASK_CATEGORIES (master-data.ts) と完全一致させる
// 旧スキーマは review / management を欠いていた (v1.2.0 で修正)
export const ESTIMATE_CATEGORY_VALUES = [
  'requirements',
  'design',
  'development',
  'testing',
  'review',
  'management',
  'other',
] as const;

// base object without refinements — used for .partial() (Zod v4: .partial() cannot be called on refined schemas)
const createEstimateBaseSchema = z.object({
  itemName: z.string().min(1, '見積項目名を入力してください').max(NAME_MAX_LENGTH),
  category: z.enum(ESTIMATE_CATEGORY_VALUES),
  // 2026-06-02: 開発方式は見積もりフォームから撤去済。未送信を許容するため optional。
  // 係数モードでツール選択時は該当ツールキーが入る。NOT NULL 列のため service 側で 'other' を既定補完する。
  devMethod: z.enum(DEV_METHOD_VALUES).optional(),
  estimatedEffort: z.number().positive('見積工数は正の数で入力してください'),
  effortUnit: z.enum(['person_hour', 'person_day']),
  // 2026-06-02: 見積根拠は不要 (備考に置換)。未送信を許容するため optional。
  rationale: z.string().max(LONG_TEXT_MAX_LENGTH).optional(),
  // feat/account-lock-and-ui-consistency 後 hotfix: DB nullable 列は .nullable() 必須 (§5.12)
  preconditions: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
  notes: z.string().max(NOTES_MAX_LENGTH).nullable().optional(),
  // v1.2.0: 係数ベースモード追加フィールド
  inputMode: z.enum(ESTIMATE_INPUT_MODES).default('direct'),
  baseHours: z.number().positive().nullable().optional(),
  scaleCoeff: z.number().positive().nullable().optional(),
  difficultyCoeff: z.number().positive().nullable().optional(),
  methodCoeff: z.number().positive().nullable().optional(),
});

export const createEstimateSchema = createEstimateBaseSchema.superRefine((data, ctx) => {
  // 係数モード時は baseHours/scaleCoeff/difficultyCoeff/methodCoeff が必須
  if (data.inputMode === 'coefficient') {
    if (!data.baseHours) {
      ctx.addIssue({ path: ['baseHours'], message: '基準時間は必須です', code: 'custom' });
    }
    if (!data.scaleCoeff) {
      ctx.addIssue({ path: ['scaleCoeff'], message: '規模係数は必須です', code: 'custom' });
    }
    if (!data.difficultyCoeff) {
      ctx.addIssue({ path: ['difficultyCoeff'], message: '難易度係数は必須です', code: 'custom' });
    }
    if (!data.methodCoeff) {
      ctx.addIssue({ path: ['methodCoeff'], message: '手法係数は必須です', code: 'custom' });
    }
  }
});

export const updateEstimateSchema = createEstimateBaseSchema.partial();

export type CreateEstimateInput = z.infer<typeof createEstimateSchema>;

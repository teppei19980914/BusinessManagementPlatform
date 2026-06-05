import { z } from 'zod/v4';
import {
  NAME_MAX_LENGTH,
  MEDIUM_TEXT_MAX_LENGTH,
  TAGS_MAX_COUNT,
} from '@/config';

// プロジェクトの 5 ステータス (2026-06-03: 完了/振り返り完了を廃止)。新規作成/編集フォームの
// status 項目と、旧 state-machine エンドポイント (changeStatusSchema) の両方で共有する単一ソース。
const projectStatusEnum = z.enum([
  'planning',
  'estimating',
  'scheduling',
  'executing',
  'closed',
]);

export const createProjectSchema = z.object({
  name: z.string().min(1, 'プロジェクト名を入力してください').max(NAME_MAX_LENGTH),
  // PR #111-2: 顧客は Customer マスタの選択式。UUID を受け取る。
  customerId: z.string().uuid({ message: '顧客を選択してください' }),
  purpose: z.string().min(1, '目的を入力してください').max(MEDIUM_TEXT_MAX_LENGTH),
  background: z.string().min(1, '背景を入力してください').max(MEDIUM_TEXT_MAX_LENGTH),
  scope: z.string().min(1, 'スコープを入力してください').max(MEDIUM_TEXT_MAX_LENGTH),
  // feat/account-lock-and-ui-consistency 後 hotfix: DB nullable 列は .nullable() 必須 (§5.12)
  outOfScope: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
  // PR-β / 項目 13: 'power_platform' → 'low_code_no_code' にリネーム + 概念拡張
  devMethod: z.enum(['scratch', 'low_code_no_code', 'package', 'other']),
  // PR-β / 項目 14: 契約形態 (新設、既存プロジェクトは null 許容)
  contractType: z.enum(['quasi_mandate', 'lump_sum', 'ses', 'other']).nullable().optional(),
  // 2026-06-03: ステータスを新規作成/編集フォームから任意に選択可能に。
  //   未指定時は service 側で 'planning' を補完 (新規作成)。状態遷移の一方向制限は課さない。
  status: projectStatusEnum.optional(),
  businessDomainTags: z.array(z.string()).max(TAGS_MAX_COUNT).optional(),
  techStackTags: z.array(z.string()).max(TAGS_MAX_COUNT).optional(),
  // PR #65: 核心機能 (提案型サービス) のため工程タグを追加 (ナレッジと同じ粒度)
  processTags: z.array(z.string()).max(TAGS_MAX_COUNT).optional(),
  plannedStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付形式が不正です'),
  plannedEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付形式が不正です'),
  // 2026-06-02: 実績日 (任意)。未入力時は空文字 or null を許容し、service 側で null 変換。
  actualStartDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付形式が不正です'), z.literal('')]).nullable().optional(),
  actualEndDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付形式が不正です'), z.literal('')]).nullable().optional(),
  notes: z.string().max(MEDIUM_TEXT_MAX_LENGTH).nullable().optional(),
});

export const updateProjectSchema = createProjectSchema.partial();

export const changeStatusSchema = z.object({
  status: projectStatusEnum,
});

export type CreateProjectSchemaInput = z.infer<typeof createProjectSchema>;

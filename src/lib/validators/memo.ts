import { z } from 'zod/v4';
import { TITLE_MAX_LENGTH, MEMO_CONTENT_MAX_LENGTH } from '@/config';

/**
 * メモの公開範囲 (PR #70 / 2026-05-11 改修)。
 *   - 'private' (既定): 作成者のみ閲覧可 (= 「自分のみ」、一時保存の意味も持つ)
 *   - 'public'        : 全ログインユーザが「全メモ」画面で閲覧可 (= 「全メンバー」、編集/削除は作成者のみ)
 *
 * 2026-05-11 / v1.3.0 軽量入力 (2026-06-19) 改訂:
 *   - visibility='private' (自分のみ): **タイトルのみ必須** (本文は任意)
 *   - visibility='public'  (全メンバー): タイトル + 本文 (content = Embedding 対象 ∩ UI 入力欄あり) を必須化
 *
 * モジュール内限定。外部 API は `createMemoSchema` / `updateMemoSchema` を通じて型を公開する。
 */
const MEMO_VISIBILITIES = ['private', 'public'] as const;

/**
 * メモ作成スキーマ。
 *
 * タグは持たせない (PR #70 要件): メモは業務知見の一時置き場で、共有資産化判断は人間の目で行う。
 *
 * 2026-05-11 / v1.3.0 (2026-06-19): 必須チェックを visibility 連動に変更。
 *   - title は zod 上は空文字 default (DB NOT NULL を満たすため) だが superRefine で常に length >= 1 を強制
 *   - visibility='public' のとき superRefine で content (本文) も length >= 1 を検証
 */
export const createMemoSchema = z
  .object({
    // 2026-05-11: visibility=private は一時保存的に空も許容 → default '' で DB NOT NULL を満たす
    title: z.string().max(TITLE_MAX_LENGTH).default(''),
    // refactor/list-create-content-optional (2026-04-27 ユーザ要望 #6):
    // 本文は visibility に関わらず任意 (空文字許容)。
    content: z.string().max(MEMO_CONTENT_MAX_LENGTH).default(''),
    visibility: z.enum(MEMO_VISIBILITIES).default('private'),
    // feat/asset-assignee-expansion (2026-05-26): 担当者 (作成者と並ぶ編集権限保持者)。
    //   memo は visibility='private' のとき他人参照不可なので、通常 assignee は public memo 用。
    //   private に他人 assignee 指定は service 層で拒否する設計 (= assignee は memo 不可視になるため)。
    assigneeId: z.string().uuid().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    // v1.3.0 軽量入力 (2026-06-19): title は private (自分のみ) / public とも常に必須。
    if (!data.title || data.title.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: 'タイトルを入力してください', path: ['title'] });
    }
    // v1.3.0: public 化時は「Embedding 対象 ∩ UI 入力欄あり」項目の本文 (content) も必須。
    if (data.visibility === 'public') {
      if (!data.content || data.content.trim().length === 0) {
        ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合は本文を入力してください', path: ['content'] });
      }
    }
  });

// updateMemoSchema は superRefine 後では .partial() が使えないため、内部の base object に対して構築する。
const baseUpdateMemoSchema = z.object({
  title: z.string().max(TITLE_MAX_LENGTH).optional(),
  content: z.string().max(MEMO_CONTENT_MAX_LENGTH).optional(),
  visibility: z.enum(MEMO_VISIBILITIES).optional(),
  // feat/asset-assignee-expansion (2026-05-26): 編集時 assigneeId 更新も受入れ
  assigneeId: z.string().uuid().nullable().optional(),
});

export const updateMemoSchema = baseUpdateMemoSchema.superRefine((data, ctx) => {
  // v1.3.0 軽量入力: title は常に必須。明示的に空へ更新しようとした場合のみ拒否 (undefined = 変更なし)。
  if (data.title !== undefined && data.title.trim().length === 0) {
    ctx.addIssue({ code: 'custom', message: 'タイトルを入力してください', path: ['title'] });
  }
  // v1.3.0: public 化 / 維持の更新で本文 (content) を空へ更新しようとした場合は拒否。
  //   フォーム未送信 (undefined) は既存値維持。本文未送信での public 化は service 層ガードで最終検証。
  if (data.visibility === 'public') {
    if (data.content !== undefined && data.content.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: '「全メンバー」に公開する場合は本文を入力してください', path: ['content'] });
    }
  }
});

export type CreateMemoInput = z.infer<typeof createMemoSchema>;
export type UpdateMemoInput = z.infer<typeof updateMemoSchema>;

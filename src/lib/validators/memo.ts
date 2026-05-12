import { z } from 'zod/v4';
import { TITLE_MAX_LENGTH, MEMO_CONTENT_MAX_LENGTH } from '@/config';

/**
 * メモの公開範囲 (PR #70 / 2026-05-11 改修)。
 *   - 'private' (既定): 作成者のみ閲覧可 (= 「自分のみ」、一時保存の意味も持つ)
 *   - 'public'        : 全ログインユーザが「全メモ」画面で閲覧可 (= 「全メンバー」、編集/削除は作成者のみ)
 *
 * 2026-05-11: 「自分のみ」は一時保存のような UX として、必須項目を緩める方針に変更。
 *   - visibility='private' のとき: タイトル空も許容 (DB は NOT NULL 制約のため '' で保存)
 *   - visibility='public' のとき : 従来どおり「タイトル必須」をバリデーション
 *
 * モジュール内限定。外部 API は `createMemoSchema` / `updateMemoSchema` を通じて型を公開する。
 */
const MEMO_VISIBILITIES = ['private', 'public'] as const;

/**
 * メモ作成スキーマ。
 *
 * タグは持たせない (PR #70 要件): メモは業務知見の一時置き場で、共有資産化判断は人間の目で行う。
 *
 * 2026-05-11: 必須チェックを visibility 連動に変更。
 *   - title は zod 上は常に optional + 空文字 default (DB NOT NULL を満たすため)
 *   - visibility='public' のとき superRefine で title.length >= 1 を検証
 */
export const createMemoSchema = z
  .object({
    // 2026-05-11: visibility=private は一時保存的に空も許容 → default '' で DB NOT NULL を満たす
    title: z.string().max(TITLE_MAX_LENGTH).default(''),
    // refactor/list-create-content-optional (2026-04-27 ユーザ要望 #6):
    // 本文は visibility に関わらず任意 (空文字許容)。
    content: z.string().max(MEMO_CONTENT_MAX_LENGTH).default(''),
    visibility: z.enum(MEMO_VISIBILITIES).default('private'),
  })
  .superRefine((data, ctx) => {
    if (data.visibility === 'public' && (!data.title || data.title.trim().length === 0)) {
      ctx.addIssue({
        code: 'custom',
        message: '「全メンバー」に公開する場合はタイトルを入力してください',
        path: ['title'],
      });
    }
  });

// updateMemoSchema は superRefine 後では .partial() が使えないため、内部の base object に対して構築する。
const baseUpdateMemoSchema = z.object({
  title: z.string().max(TITLE_MAX_LENGTH).optional(),
  content: z.string().max(MEMO_CONTENT_MAX_LENGTH).optional(),
  visibility: z.enum(MEMO_VISIBILITIES).optional(),
});

export const updateMemoSchema = baseUpdateMemoSchema.superRefine((data, ctx) => {
  // 2026-05-11: 更新時に visibility が指定された場合のみチェック (= 部分更新でも整合)。
  //   visibility='public' に変更 / 維持する場合は title が空でないこと
  if (data.visibility === 'public' && data.title !== undefined && data.title.trim().length === 0) {
    ctx.addIssue({
      code: 'custom',
      message: '「全メンバー」に公開する場合はタイトルを入力してください',
      path: ['title'],
    });
  }
});

export type CreateMemoInput = z.infer<typeof createMemoSchema>;
export type UpdateMemoInput = z.infer<typeof updateMemoSchema>;

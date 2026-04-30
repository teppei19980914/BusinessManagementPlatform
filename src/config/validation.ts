/**
 * バリデーション定数 (PR #81 で集約):
 *
 *   フォーム入力の文字数上限 / 配列上限 / その他バリデーション数値を一箇所に集約する。
 *   Zod スキーマ (`src/lib/validators/`) と JSX (`maxLength={N}`) の両方から参照することで、
 *   「サーバ側 Zod は 100 文字まで許可、UI maxLength は 80 文字」のような乖離を防ぐ。
 *
 * 値を変更する際の影響:
 *   - 既存データ: 短くした場合、既存 DB レコードに収まらないものが編集できなくなる可能性
 *     (UI で長すぎる値を表示・送信時にバリデーションで弾く)
 *   - 関連 DB スキーマ: prisma/schema.prisma の VARCHAR 長との整合に注意。
 *     例: Knowledge.title VARCHAR(150) ↔ KNOWLEDGE_TITLE_MAX = 150
 *
 * 設計判断:
 *   - 「タイトル」「内容」など概念別に名前を付ける (フィールド名そのものを使うと
 *     ProjectName と CustomerName で重複命名が起きるため)
 *   - 同じ概念で値が違うものは個別に分ける (Knowledge.title=150 / Project.name=100)
 */

// ---------- 短いテキスト (タイトル・名称) ----------

/** プロジェクト名 / 顧客名 / ユーザ名 / メンバー名 等の汎用「名称」フィールド上限。 */
export const NAME_MAX_LENGTH = 100;

/** Memo / Knowledge / RiskIssue 等の「タイトル」フィールド上限。
 *  prisma/schema.prisma の knowledges.title VARCHAR(150) / memos.title VARCHAR(150) と整合。 */
export const TITLE_MAX_LENGTH = 150;

/** 添付ファイルの表示名 / プロジェクト見積もりの項目名等、やや長めの名称。 */
export const DISPLAY_NAME_MAX_LENGTH = 200;

// ---------- 中程度テキスト (背景・備考・補足) ----------

/** プロジェクト備考 / 見積もり備考 等の中程度テキスト。 */
export const NOTES_MAX_LENGTH = 1000;

/** 振り返り各項目 / Knowledge 背景 / リスク内容 等の中程度テキスト。 */
export const MEDIUM_TEXT_MAX_LENGTH = 2000;

/** リスク・課題本文 / 振り返り総括 等のやや長いテキスト。 */
export const LONG_TEXT_MAX_LENGTH = 3000;

// ---------- 長いテキスト (本文・メモ) ----------

/** Knowledge 内容の上限 (技術手順や経緯説明を想定)。 */
export const KNOWLEDGE_CONTENT_MAX_LENGTH = 5000;

/** Memo 本文の上限 (個人ノート、相対的に長文を許容)。 */
export const MEMO_CONTENT_MAX_LENGTH = 10000;

/**
 * コメント本文の上限 (PR #199)。
 * MVP は議論用の中規模テキストとして 2000 文字に揃える (MEDIUM_TEXT_MAX_LENGTH と同値だが、
 * 業務的意味が異なるため独立定数とする)。
 */
export const COMMENT_CONTENT_MAX_LENGTH = 2000;

// ---------- URL / 添付関連 ----------

/** 添付 URL の上限 (DB は VARCHAR(2000) で揃える)。 */
export const URL_MAX_LENGTH = 2000;

/** 添付 slot 名 (general / primary / source 等の識別子) の上限。 */
export const ATTACHMENT_SLOT_MAX_LENGTH = 30;

/** 添付 mimeHint (image/png 等) の上限。 */
export const ATTACHMENT_MIME_HINT_MAX_LENGTH = 50;

// ---------- 配列上限 (タグ等) ----------

/** タグ配列の上限 (techTags / processTags / businessDomainTags 共通)。 */
export const TAGS_MAX_COUNT = 50;

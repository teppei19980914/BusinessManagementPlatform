/**
 * セキュリティ / 認証関連定数 (PR #75 Phase 1):
 *
 *   パスワードハッシュ・アカウントロック・セッション・トークン期限など
 *   セキュリティ面の定数を単一ファイルに集約する。
 *
 * 集約方針:
 *   - ここまでサービス / ルート各層に `const BCRYPT_COST = 12;` が重複していたものを一箇所に
 *   - DESIGN.md §9 (セキュリティ設計) に対応する値は本ファイルの識別子名と揃える
 *   - タイムスパン系は `*_MS` (ミリ秒) か `*_SEC` (秒) を末尾に付けて単位を明示
 *
 * 値を変更する際の影響範囲:
 *   - BCRYPT_COST: 既存ユーザの再ハッシュには再ログインが必要 (影響は漸進的)
 *   - PASSWORD_HISTORY_COUNT: 値を減らすと履歴に残らず再利用可能になるパスワードが増える
 *   - LOGIN_FAILURE_MAX: 値を減らすとロックまでの試行回数が減る (セキュリティ強化、UX 低下)
 */

// ---------- パスワード / ハッシュ ----------

/** bcrypt コストパラメータ。12 は 2026 年時点で OWASP 推奨レベル。数値を上げると演算コスト指数増。 */
export const BCRYPT_COST = 12;

/** パスワード履歴の保持件数。直近 N 回と同一のパスワードは再設定不可。 */
export const PASSWORD_HISTORY_COUNT = 5;

// ---------- アカウントロック ----------

/** ログイン失敗の上限回数。これを超えると一時ロック。DESIGN.md §9.4.4 */
export const LOGIN_FAILURE_MAX = 5;

/** 一時ロックの継続時間 (ミリ秒)。ロック後この時間経過すると自動解除。 */
export const TEMPORARY_LOCK_DURATION_MS = 30 * 60 * 1000; // 30 分

/**
 * 非アクティブ自動削除の猶予期間 (日) — PR #89。
 * lastLoginAt (未ログインの場合 createdAt) からこの日数を経過したアカウントは
 * 日次 cron `/api/admin/users/cleanup-inactive` で論理削除される。
 * ProjectMember も同時に物理削除されるため、メンバ一覧から消えた時点で
 * 管理者が手動削除を忘れても DB 整合性は担保される。
 */
export const INACTIVE_USER_DELETION_DAYS = 30;

// ---------- セッション (NextAuth JWT) ----------

/**
 * JWT 自体の有効期限 (秒)。NextAuth の session.maxAge に渡すため、
 * **アクセスが無い状態が継続した場合の強制ログアウトまでの時間** として機能する
 * (NextAuth JWT 戦略は各リクエストで token を再署名する sliding 挙動 = アイドル時間上限)。
 *
 * PR #124 (2026-04-24): 24 時間 → 9 時間 に短縮。
 *   日本の通常就業時間 (8 時間 + 休憩 1 時間 = 9 時間) を超えて無操作なら強制ログアウト。
 *   cookie は maxAge 未指定のセッション cookie 運用のため、ブラウザ/タブを閉じた時点でも失効する。
 */
export const SESSION_JWT_MAX_AGE_SEC = 9 * 60 * 60; // 9 時間 (就業時間 + 休憩)

// ---------- ワンタイムトークン ----------

/** メール検証トークンの有効期限 (時間)。招待メール等で使用。 */
export const EMAIL_VERIFICATION_TOKEN_EXPIRY_HOURS = 24;

/** パスワードリセットトークンの有効期限 (分)。短めに設定し、漏洩時のリスクを最小化。 */
export const PASSWORD_RESET_TOKEN_EXPIRY_MINUTES = 30;

/** リカバリーコードの生成個数。アカウント作成時にこの個数だけ発行する。 */
export const RECOVERY_CODE_COUNT = 10;

/**
 * リカバリーコード生成に使う文字集合。紛らわしい文字 (0/O, 1/I/L) を除外。
 * 文字数 32 (= 2^5) なので randomBytes からの変換で偏りが出にくい。
 */
export const RECOVERY_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------- パスワードポリシー ----------

/** パスワード最小文字数。DESIGN.md §9.4.2 */
export const PASSWORD_MIN_LENGTH = 10;

/** パスワード最大文字数 (DoS 対策で bcrypt に渡す前に上限を設ける)。 */
export const PASSWORD_MAX_LENGTH = 128;

/** パスワードに必要な文字種類の最小数 (英大/英小/数字/記号 のうち何種類含むか)。 */
export const PASSWORD_REQUIRED_CHAR_TYPE_COUNT = 3;

/** 同一文字の連続使用禁止。N 文字以上の連続はバリデーションエラー。 */
export const PASSWORD_MAX_CONSECUTIVE_SAME_CHARS = 4;

// ---------- ヘルスチェック ----------

/** /api/health で DB ping に許容するタイムアウト (ミリ秒)。これを超えたら "degraded"。 */
export const DB_PING_TIMEOUT_MS = 5_000;

/**
 * Stripe decline_code → 顧客向け日本語メッセージのマッピング (PR-S2 / 2026-05-14)
 *
 * 役割:
 *   Stripe API の `StripeCardError.decline_code` を顧客が理解できる日本語に変換する。
 *   各エラーコードに severity (high / medium / low) を付与し、UI 側の色分け・推奨アクションに使う。
 *
 * 関連:
 *   - 詳細設計: docs/design/STRIPE_TECHNICAL_DESIGN.md §B-1
 *   - UI 仕様: docs/specification/STRIPE_PAYMENT_UI.md §2.4 (トースト表示)
 *   - 公式ドキュメント: https://docs.stripe.com/declines/codes
 */

export type StripeDeclineSeverity = 'high' | 'medium' | 'low';

export type StripeDeclineMessage = {
  /** 顧客向け日本語メッセージ */
  ja: string;
  /** 重要度 (= UI の色分け、アクション案内の調整に使用) */
  severity: StripeDeclineSeverity;
};

/**
 * Stripe `card_declined` の decline_code パターンを網羅的にマッピング。
 *
 * 出典: Stripe 公式ドキュメント [Decline codes](https://docs.stripe.com/declines/codes)
 *
 * severity の意味:
 *   - high: 顧客の対応が必要 (カード変更、CVC 確認等)。明確な失敗
 *   - medium: カードを変えれば解決する可能性あり (= card_not_supported, fraudulent 等)
 *   - low: 一時的、再試行で解決する可能性 (= issuer_not_available, try_again_later)
 */
export const STRIPE_DECLINE_CODE_MESSAGES: Record<string, StripeDeclineMessage> = {
  // ── 高: 顧客対応必須 ──────────────────────────────────────
  insufficient_funds:    { ja: 'カード残高が不足しています', severity: 'high' },
  expired_card:          { ja: 'カードの有効期限が切れています', severity: 'high' },
  incorrect_cvc:         { ja: 'セキュリティコード (CVC) が誤っています', severity: 'high' },
  incorrect_number:      { ja: 'カード番号が誤っています', severity: 'high' },
  invalid_cvc:           { ja: 'セキュリティコード (CVC) の形式が誤っています', severity: 'high' },
  invalid_expiry_month:  { ja: 'カードの有効期限 (月) が誤っています', severity: 'high' },
  invalid_expiry_year:   { ja: 'カードの有効期限 (年) が誤っています', severity: 'high' },
  invalid_number:        { ja: 'カード番号の形式が誤っています', severity: 'high' },
  lost_card:             { ja: 'カードが紛失届出済のため使用できません (カード会社にお問い合わせください)', severity: 'high' },
  stolen_card:           { ja: 'カードが盗難届出済のため使用できません (カード会社にお問い合わせください)', severity: 'high' },
  pickup_card:           { ja: 'カードが利用停止されています (カード会社にお問い合わせください)', severity: 'high' },
  restricted_card:       { ja: 'このカードは制限されています (別のカードをお試しください)', severity: 'high' },

  // ── 中: 別カードで解決可 / カード会社問合せ ─────────────
  card_not_supported:    { ja: 'このカードは本サービスで利用できません (別のカードをお試しください)', severity: 'medium' },
  currency_not_supported:{ ja: 'このカードは日本円決済に対応していません', severity: 'medium' },
  duplicate_transaction: { ja: '直近に同額の決済があります (重複の可能性)', severity: 'medium' },
  fraudulent:            { ja: '不正の疑いがあるため拒否されました (カード会社にお問い合わせください)', severity: 'medium' },
  generic_decline:       { ja: 'カードが拒否されました (カード会社にお問い合わせください)', severity: 'medium' },
  do_not_honor:          { ja: 'カードが拒否されました (詳細はカード会社にお問い合わせください)', severity: 'medium' },

  // ── 低: 一時的、再試行可 ─────────────────────────────────
  issuer_not_available:  { ja: 'カード発行会社が一時的に応答していません (時間をおいて再試行)', severity: 'low' },
  processing_error:      { ja: 'Stripe 側で処理エラーが発生しました (時間をおいて再試行)', severity: 'low' },
  try_again_later:       { ja: '一時的なエラーです (時間をおいて再試行)', severity: 'low' },
  reenter_transaction:   { ja: '取引情報の再入力が必要です (時間をおいて再試行)', severity: 'low' },
};

/** デフォルトメッセージ (= decline_code が不明な場合) */
const DEFAULT_DECLINE_MESSAGE: StripeDeclineMessage = {
  ja: 'カードが拒否されました (詳細不明、カード会社にお問い合わせください)',
  severity: 'medium',
};

/**
 * decline_code から顧客向け日本語メッセージを取得。
 *
 * @param declineCode Stripe の StripeCardError.decline_code (null 可)
 * @returns 顧客向けメッセージ。未知の code でも必ず何かを返す (= 安全側、unknown_decline 扱い)
 */
export function getDeclineMessage(
  declineCode: string | null | undefined,
): StripeDeclineMessage {
  if (declineCode == null) return DEFAULT_DECLINE_MESSAGE;
  return STRIPE_DECLINE_CODE_MESSAGES[declineCode] ?? DEFAULT_DECLINE_MESSAGE;
}

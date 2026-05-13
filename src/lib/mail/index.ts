import type { MailProvider, MailParams, MailResult } from './mail-provider';
import { ConsoleMailProvider } from './console-provider';
import { ResendMailProvider } from './resend-provider';
import { BrevoMailProvider } from './brevo-provider';
import { InboxMailProvider } from './inbox-provider';
import { recordError } from '@/services/error-log.service';
import {
  recordEmailSend,
  isDailyEmailLimitReached,
  type EmailSendType,
} from '@/services/email-send-log.service';

export type { MailProvider, MailParams, MailResult } from './mail-provider';

/**
 * PR #115 (2026-04-24): console.warn を全て system_error_logs に切替。
 * provider 選択の失敗 / フォールバックは DB に残す。
 */
export function createMailProvider(): MailProvider {
  const provider = process.env.MAIL_PROVIDER || 'console';
  switch (provider) {
    case 'brevo':
      if (!process.env.BREVO_API_KEY) {
        void recordError({
          severity: 'warn',
          source: 'mail',
          message: '[MailProvider] MAIL_PROVIDER=brevo ですが BREVO_API_KEY が未設定。console にフォールバック',
        });
        return new ConsoleMailProvider();
      }
      // 2026-05-13 (security/config-hardening, B-7): MAIL_FROM 必須化。
      //   未設定で従来 'noreply@example.com' に落ちる挙動は DMARC fail を引き起こし、
      //   ドメインレピュテーション損傷 + 大量バウンスのリスク。本番 (brevo) では
      //   必ず正規ドメインの送信元を要求し、設定漏れなら console fallback で fail-safe にする。
      if (!process.env.MAIL_FROM) {
        void recordError({
          severity: 'error',
          source: 'mail',
          message: '[MailProvider] MAIL_PROVIDER=brevo ですが MAIL_FROM が未設定。example.com フォールバック禁止のため console にフォールバック',
        });
        return new ConsoleMailProvider();
      }
      return new BrevoMailProvider();
    case 'resend':
      if (!process.env.RESEND_API_KEY) {
        void recordError({
          severity: 'warn',
          source: 'mail',
          message: '[MailProvider] MAIL_PROVIDER=resend ですが RESEND_API_KEY が未設定。console にフォールバック',
        });
        return new ConsoleMailProvider();
      }
      // 2026-05-13 (security/config-hardening, B-7): MAIL_FROM 必須化 (同上)。
      //   resend-provider のデフォルト 'onboarding@resend.dev' は Resend 公式テストドメインで、
      //   本番運用では不適切 (送信制限 + 顧客向けには不自然)。
      if (!process.env.MAIL_FROM) {
        void recordError({
          severity: 'error',
          source: 'mail',
          message: '[MailProvider] MAIL_PROVIDER=resend ですが MAIL_FROM が未設定。resend.dev フォールバック禁止のため console にフォールバック',
        });
        return new ConsoleMailProvider();
      }
      return new ResendMailProvider();
    case 'inbox': {
      // PR #92: E2E 専用。INBOX_DIR に JSON を書き出す。本番では指定しないこと。
      const dir = process.env.INBOX_DIR;
      if (!dir) {
        void recordError({
          severity: 'warn',
          source: 'mail',
          message: '[MailProvider] MAIL_PROVIDER=inbox ですが INBOX_DIR が未設定。console にフォールバック',
        });
        return new ConsoleMailProvider();
      }
      return new InboxMailProvider(dir);
    }
    case 'console':
    default:
      return new ConsoleMailProvider();
  }
}

// シングルトン
let mailProvider: MailProvider | null = null;
let loggingProvider: MailProvider | null = null;

export function getMailProvider(): MailProvider {
  if (!loggingProvider) {
    if (!mailProvider) {
      mailProvider = createMailProvider();
    }
    // P-H (2026-05-08): 全送信ログ記録 + 日次上限チェックの decorator で wrap。
    //   既存呼出 (sendVerificationEmail / usage alert / Beginner 警告) は変更不要。
    loggingProvider = wrapWithLogging(mailProvider);
  }
  return loggingProvider;
}

/**
 * P-H (2026-05-08): MailProvider を log 記録 + 上限チェックでラップする decorator。
 *
 * 動作:
 *   1. 送信前に日次上限チェック → 超過なら send をブロック (= 'daily_limit_exceeded' で
 *      record + provider.send は呼ばない)
 *   2. send 実行 → 戻り値 (success / error) を email_send_logs に記録
 *   3. 失敗時はそのまま戻り値を caller に渡す (= 既存の handling を維持)
 *
 * 設計判断:
 *   - **ログ記録は send の前後で行う** (前: 上限チェック、後: 結果記録)
 *   - **ログ記録自体の失敗は無視** (= 本体送信のフローを止めない、recordEmailSend 側で握り潰し)
 *   - **type の決定**: params.type が指定されていればそれ、未指定なら 'unknown'
 *   - **provider 名**: 環境変数 MAIL_PROVIDER (or 'console' fallback)
 */
function wrapWithLogging(provider: MailProvider): MailProvider {
  const providerName = process.env.MAIL_PROVIDER || 'console';

  return {
    async send(params: MailParams): Promise<MailResult> {
      const type = params.type ?? 'unknown';
      const tenantId = params.tenantId;

      // 上限チェック: 日次上限到達なら send せず failure として記録
      const limitReached = await isDailyEmailLimitReached();
      if (limitReached) {
        await recordError({
          severity: 'error',
          source: 'mail',
          message:
            '日次メール送信上限に達したため送信をブロックしました (EMAIL_DAILY_LIMIT)。' +
            '上限値の引き上げまたは上位プラン契約をご検討ください。',
          context: { type, recipientDomain: extractDomain(params.to) },
        });
        await recordEmailSend({
          type: type as EmailSendType,
          recipientEmail: params.to,
          success: false,
          errorMessage: 'daily_limit_exceeded',
          providerName,
          tenantId,
        });
        return {
          success: false,
          error: '日次メール送信上限に達しました。しばらく待ってから再試行してください。',
        };
      }

      // 通常送信
      const result = await provider.send(params);

      // 結果を log 記録
      await recordEmailSend({
        type: type as EmailSendType,
        recipientEmail: params.to,
        success: result.success,
        errorMessage: result.success ? undefined : result.error,
        providerName,
        tenantId,
      });

      return result;
    },
  };
}

function extractDomain(email: string): string {
  const at = email.indexOf('@');
  return at >= 0 ? email.slice(at) : '';
}

/** テスト用: シングルトンを破棄して次回 getMailProvider で再構築させる */
export function _resetMailProviderForTest(): void {
  mailProvider = null;
  loggingProvider = null;
}

# インフラ構成 (Program Design / Infrastructure)

本ドキュメントは、Vercel + Supabase の現行インフラ構成を集約する (DESIGN.md §10、§18)。AWS / Azure 移行計画は [../operations/MIGRATION_TO_AWS.md](../operations/MIGRATION_TO_AWS.md)、デプロイ手順は [../operations/DEPLOYMENT.md](../operations/DEPLOYMENT.md) を参照。

---

## §10. インフラ構成

## 10. インフラ構成

### 10.0 デプロイ方針 (PR #123 で整理)

本システムは **自社運用 (Vercel + Supabase) 一本** で運用する (2026-04-24 時点)。

| 項目 | 状態 |
|---|---|
| デプロイ形態 | Vercel + Supabase のみ (§10.2 参照) |
| 外部配布 (.zip / Docker / オンプレ / AWS / Azure 等) | **現時点で非対応**、体制・構成未整備のため記載を削除。将来的な必要性を鑑みて再検討する |
| 開発環境 | ローカル PostgreSQL (Docker) or Supabase 接続、詳細は §10.1 |

過去に docs 内に Docker Compose / オンプレミス / AWS / Azure 等の外部配布方針を記載していたが、
体制・構成が整備されていないため誤認を避ける目的で PR #123 で削除した。再導入する場合は
git 履歴から過去記述を参照できる。

### 10.1 開発環境構成図

```
┌──────────────────────────────────────────────────────────┐
│                    Developer Machine                      │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │              Docker Compose                        │  │
│  │                                                    │  │
│  │  ┌──────────────────┐  ┌────────────────────────┐ │  │
│  │  │  app              │  │  db                    │ │  │
│  │  │  Next.js (dev)    │  │  PostgreSQL 16         │ │  │
│  │  │  Port: 3000       │──│  Port: 5432            │ │  │
│  │  │  Hot Reload       │  │  Volume: pgdata        │ │  │
│  │  └──────────────────┘  └────────────────────────┘ │  │
│  │                                                    │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  ツール                                             │  │
│  │  - Node.js 22 LTS                                  │  │
│  │  - pnpm (パッケージマネージャ)                       │  │
│  │  - Prisma CLI                                      │  │
│  │  - Claude Code (開発支援)                           │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### 10.2 運用環境構成（無料枠）

初期フェーズでは Vercel Hobby + Supabase Free + Brevo Free の無料構成で運用する。

```
┌──────────────────────────────────────────────────────────────┐
│  Browser (HTTPS)                                              │
└──────────────┬───────────────────────────────────────────────┘
               | HTTPS
┌──────────────┴───────────────────────────────────────────────┐
│  Vercel Hobby (無料)                                          │
│  - Next.js (App Router, Standalone)                          │
│  - Edge Network (CDN)                                        │
│  - 自動 SSL (Let's Encrypt)                                  │
│  - 帯域: 100GB/月                                            │
│  制約: 商用利用不可（個人の試験運用用途）                        │
└──────────────┬───────────────────────────────────────────────┘
               | Connection Pooler (IPv4)
┌──────────────┴───────────────────────────────────────────────┐
│  Supabase Free (無料)                                         │
│  - PostgreSQL 15                                              │
│  - ストレージ: 500MB                                          │
│  - Pooler 経由接続（Transaction mode）                        │
│  - 1週間無操作でプロジェクト一時停止（手動再開可）              │
│  制約: 直接接続不可、バックアップは日次自動のみ                 │
└──────────────────────────────────────────────────────────────┘

  メール送信: Brevo Free (300通/日)
  CI/CD: GitHub Actions (無料枠: 2,000分/月)
  ドメイン: Vercel サブドメイン (*.vercel.app)
```

#### 月額コスト

| コンポーネント | サービス | 月額 |
|---|---|---|
| アプリケーション | Vercel Hobby | $0 |
| データベース | Supabase Free (500MB) | $0 |
| メール送信 | Brevo Free (300通/日) | $0 |
| CI/CD | GitHub Actions (2,000分/月) | $0 |
| ドメイン | Vercel サブドメイン | $0 |
| **合計** | | **$0/月** |

#### 無料枠の制約と対策

| 制約 | 影響 | 対策 |
|---|---|---|
| Vercel Hobby: 商用利用不可 | 試験運用フェーズのみ利用可 | 本格運用時に Pro ($20/月) へ移行 |
| Supabase Free: 500MB | 約3年で逼迫（ログ制御後） | ログ保持期間の厳格化で 5 年以上対応可 |
| Supabase Free: 1週間無操作で停止 | 長期休暇時にDBが停止 | ダッシュボードから手動再開、または定期的なヘルスチェック |
| Supabase Free: Pooler 経由のみ | Prisma の一部機能に制約 | Transaction mode 対応の接続設定を使用 |
| Brevo Free: 300通/日 | 初期フェーズでは十分 | ユーザ増加時に Starter ($9/月) へ移行 |

#### データ量の見積もり（ログ制御後）

| 期間 | ビジネスデータ | 監査ログ | 合計 | 500MB に対する使用率 |
|---|---|---|---|---|
| 1年後 | ~8MB | ~36MB | ~44MB | 9% |
| 3年後 | ~24MB | ~36MB（1年保持で削除） | ~60MB | 12% |
| 5年後 | ~40MB | ~36MB（1年保持で削除） | ~76MB | 15% |

※ operation_trace_logs を初期フェーズで無効化し、audit_logs は 1 年保持で物理削除する前提

### 10.3 将来の有料構成（スケール時）

ユーザ数増加・本格運用移行時は以下の構成に段階的に移行する。

| トリガー | 移行先 | 追加コスト |
|---|---|---|
| 商用利用の開始 | Vercel Pro | +$20/月 |
| DB 500MB 超過 or 直接接続が必要 | Supabase Pro | +$25/月 |
| メール 300通/日超過 | Brevo Starter | +$9/月 |
| 独自ドメインが必要 | ドメイン取得 | +~$1/月 |
| 大規模運用（100名超） | AWS / Azure への移行 | 要別途見積もり |

### 10.4 環境変数一覧

> 詳細は [`docs/administrator/OPERATION.md §1`](../administrator/OPERATION.md#1-環境変数一覧) に集約。本節は概要のみ。

| 変数名 | 説明 | 例 |
|---|---|---|
| DATABASE_URL | PostgreSQL 接続文字列 (Supabase pooler) | postgresql://...:6543/postgres?pgbouncer=true |
| DIRECT_URL | 直接接続文字列 (migration 用) | postgresql://...:5432/postgres |
| NEXTAUTH_URL | アプリケーション URL | http://localhost:3000 or Vercel URL |
| NEXTAUTH_SECRET | NextAuth 暗号化キー | ランダム文字列（32文字以上） |
| NODE_ENV | 実行環境 | development / production |
| MAIL_PROVIDER | メール送信プロバイダ | console（デフォルト）/ brevo（本番推奨）/ resend（代替）/ inbox（E2E 専用） |
| BREVO_API_KEY | Brevo API キー（MAIL_PROVIDER=brevo 時、本番既定） | xkeysib-xxxxxxxxxx |
| MAIL_FROM_NAME | メール送信元表示名（Brevo のみ） | たすきば |
| RESEND_API_KEY | Resend API キー（MAIL_PROVIDER=resend 時、代替選択肢） | re_xxxxxxxxxx |
| MAIL_FROM | メール送信元アドレス | noreply@example.com |
| INITIAL_ADMIN_EMAIL | 初期管理者メールアドレス（シード用） | admin@example.com |
| INITIAL_ADMIN_PASSWORD | 初期管理者パスワード（シード用） | （ポリシー準拠のパスワード） |
| SEARCH_PROVIDER | 検索プロバイダ | pg_trgm（デフォルト） |
| ENABLE_OPERATION_TRACE | 操作トレースログの有効/無効 | false（初期）/ true（本格運用時） |
| APP_DEFAULT_TIMEZONE / APP_DEFAULT_LOCALE | i18n 既定値 (PR #118) | Asia/Tokyo / ja-JP |

> **注**: `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` の記載を PR #123 で削除。
> 過去 docs に記載されていたが、`src/lib/mail/index.ts` の `createMailProvider()` に `smtp`
> ケースが存在せず (実装未提供)、指定しても console フォールバックになるため誤認回避。

#### ローカル開発時のみ (Docker Compose)

| 変数名 | 説明 | デフォルト |
|---|---|---|
| APP_PORT | アプリケーション公開ポート | 3000 |
| DB_PORT | PostgreSQL 公開ポート | 5433（5432 との競合回避） |
| DB_NAME | データベース名 | tasukiba |
| DB_USER | データベースユーザ | postgres |
| DB_PASSWORD | データベースパスワード | （必須設定） |

#### 環境別の DATABASE_URL / DIRECT_URL

| 環境 | DATABASE_URL | DIRECT_URL |
|---|---|---|
| 自社 (Supabase、本番) | Pooler 経由 (ポート 6543, ?pgbouncer=true) | 直接接続 (ポート 5432) |
| ローカル開発 (Docker) | postgresql://postgres:postgres@localhost:5433/tasukiba | DATABASE_URL と同一 |

> **注**: Docker 配布 / 非 Docker 配布 / オンプレミス構成は PR #123 で記載削除 (体制・構成未整備、§10.0 参照)。

---


## §18. 通知（メール送信）設計

## 18. 通知（メール送信）設計

### 18.1 メール送信サービス

| 項目 | 選定内容 |
|---|---|
| サービス | Brevo（https://www.brevo.com/）★推奨 |
| 選定理由 | 無料枠で任意宛先に送信可能（300通/日）、ドメイン未検証でも送信可、API がシンプル |
| 代替 | Resend（https://resend.com/）— 要ドメイン検証、3,000通/月 |

### 18.2 将来の移行を考慮した設計

メール送信ロジックを抽象インターフェースとして定義し、サービスを差し替え可能にする。

```typescript
// lib/mail/mail-provider.ts
export interface MailProvider {
  send(params: MailParams): Promise<MailResult>;
}

export type MailParams = {
  to: string;
  subject: string;
  html: string;        // レンダリング済み HTML
  text?: string;       // プレーンテキスト（フォールバック）
  replyTo?: string;
};

export type MailResult = {
  success: boolean;
  messageId?: string;
  error?: string;
};
```

```typescript
// lib/mail/brevo-provider.ts（MVP 実装 — 推奨）
export class BrevoMailProvider implements MailProvider {
  async send(params: MailParams): Promise<MailResult> {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
      body: JSON.stringify({
        sender: { name: process.env.MAIL_FROM_NAME, email: process.env.MAIL_FROM },
        to: [{ email: params.to }],
        subject: params.subject,
        htmlContent: params.html,
      }),
    });
    const data = await res.json();
    return { success: res.ok, messageId: data.messageId };
  }
}

// lib/mail/resend-provider.ts（代替: 要ドメイン検証）
// lib/mail/console-provider.ts（開発環境用: コンソール出力）
// lib/mail/inbox-provider.ts（E2E テスト専用: ファイル出力）
```

```typescript
// lib/mail/index.ts
// 環境変数 MAIL_PROVIDER で切替
export function createMailProvider(): MailProvider {
  const provider = process.env.MAIL_PROVIDER || 'console';
  switch (provider) {
    case 'brevo': return new BrevoMailProvider();  // 本番推奨
    case 'resend': return new ResendMailProvider();  // 代替選択肢
    case 'inbox': return new InboxMailProvider(process.env.INBOX_DIR);  // E2E
    case 'console':
    default: return new ConsoleMailProvider();
  }
}
```

> **注**: PR #123 で `smtp` ケース記載を削除 (実装未提供で指定時 console fallback、docs 債務清算)。

### 18.3 メールテンプレート一覧

| テンプレート名 | 件名 | トリガー | 主な内容 |
|---|---|---|---|
| email-verification | アカウントの有効化 | アカウント登録時 | 検証リンク（有効期限24時間） |
| password-reset-complete | パスワード変更完了 | パスワードリセット完了時 | 変更日時、心当たりがない場合の連絡先 |
| password-changed | パスワード変更完了 | パスワード変更時（ログイン中） | 同上 |
| account-inactive-warning | アカウント無効化の警告 | 最終ログインから23日後 | 残り日数、ログインリンク |
| account-deactivated | アカウントが無効化されました | 最終ログインから30日後 | 復帰方法、物理削除までの日数 |
| mfa-enabled | 多要素認証が有効化されました | MFA 有効化時 | 設定日時 |
| admin-role-change-alert | 権限変更通知 | 権限変更時（管理者向け） | 対象ユーザ、変更内容、変更者 |

### 18.4 送信の実装方針

| 項目 | 方針 |
|---|---|
| 送信タイミング | サーバ処理内で非同期送信（レスポンスをブロックしない） |
| リトライ | 送信失敗時に最大3回リトライ（指数バックオフ: 1秒→4秒→16秒） |
| ログ記録 | 送信成功/失敗を audit_logs に記録（operation_trace_logs 有効時はそちらにも記録） |
| テンプレート管理 | React Email コンポーネントとして管理 |
| 開発環境 | ConsoleMailProvider でコンソールに出力（実送信しない） |
| 送信元アドレス | 環境変数 MAIL_FROM で設定（例: noreply@example.com） |

### 18.5 環境変数

| 変数名 | 説明 | 例 |
|---|---|---|
| RESEND_API_KEY | Resend の API キー | re_xxxxxxxxxx |
| MAIL_FROM | 送信元メールアドレス | noreply@example.com |

---


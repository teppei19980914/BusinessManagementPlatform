# インフラ構成 (Program Design / Infrastructure)

本ドキュメントは、Netlify + Supabase の現行インフラ構成を集約する (DESIGN.md §10、§18)。AWS / Azure 移行計画は [../operations/MIGRATION_TO_AWS.md](../operations/MIGRATION_TO_AWS.md)、デプロイ手順は [../operations/DEPLOYMENT.md](../operations/develop/DEPLOYMENT.md)、Vercel→Netlify 移行の経緯は [ADR-0023](../adr/0023-netlify-starter-migration.md) を参照。

---

## §10. インフラ構成

## 10. インフラ構成

### 10.0 デプロイ方針 (PR #123 で整理)

本システムは **自社運用 (Netlify + Supabase) 一本** で運用する (2026-05-18 Vercel から移行、ADR-0023 参照)。

| 項目 | 状態 |
|---|---|
| デプロイ形態 | Netlify + Supabase のみ (§10.2 参照) |
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

### 10.2 運用環境構成（Netlify Personal + Supabase Free）

6/1 正式リリース以降、本サービスは商用利用 (Expert/Pro 課金プラン稼働) フェーズに入る。
**Vercel Hobby は規約上商用利用不可** のため、2026-05-18 に **Netlify Starter** へ移行し、credits 制約により **Netlify Personal ($9/seat/month)** へ昇格した。詳細は [ADR-0023](../adr/0023-netlify-starter-migration.md) を参照。

> ⚠️ **as-built の真値は Netlify Personal ($9/月・統合 credits 1,000/月)**。
> `netlify.toml` の build skip コメント内に残る「Starter 統合 credits 300/月」および ADR-0023 本文の「Starter / Pro」表記は **移行途中のレガシー記述** であり、現行プランは Personal。コスト・credits 判断は本書を正とする (memory: 現行ホスティングは Netlify Personal $9、Pro ではない)。

```
┌──────────────────────────────────────────────────────────────┐
│  Browser (HTTPS)                                              │
└──────────────┬───────────────────────────────────────────────┘
               | HTTPS
┌──────────────┴───────────────────────────────────────────────┐
│  Netlify Personal ($9/seat/month・商用利用 OK)                │
│  - Next.js (App Router, Standalone)                          │
│  - @netlify/plugin-nextjs (Functions = AWS Lambda)            │
│  - Global CDN                                                 │
│  - 自動 SSL                                                   │
│  - 帯域: credits 枠で消費 (20 credits/GB)                     │
│  - 統合 credits: 1,000/月 (★ 2026 年以降の単一枠制)           │
│    └─ Production deploy ~15 credits/回、PR Preview も同 ~15  │
│    └─ Web req / Compute / Bandwidth は微小消費                │
│  - Function 実行: 10 秒 (Sync 固定、Background Functions は Pro 以上限定) │
└──────────────┬───────────────────────────────────────────────┘
               | アプリ実行: Pooler (IPv4, port 6543, DATABASE_URL)
               | migration : 直結 (port 5432, DIRECT_URL)
┌──────────────┴───────────────────────────────────────────────┐
│  Supabase Free (無料)                                         │
│  - PostgreSQL 16 系 (ARCHITECTURE.md と統一)                  │
│  - 拡張: vector(pgvector) / pg_trgm 有効 (= 意味検索 + 全文検索)│
│  - ストレージ: 500MB (DB) + Storage bucket `attachments`      │
│  - 接続2系統:                                                 │
│    · DATABASE_URL = Pooler (port 6543, Transaction mode,      │
│      ?pgbouncer=true) — アプリ実行時 (接続数抑制)             │
│    · DIRECT_URL   = 直結 (port 5432, Session mode) —          │
│      Prisma migration 用 (pooler では advisory lock 不可)     │
│  - 1週間無操作でプロジェクト一時停止（手動再開可）              │
│  制約: バックアップは日次自動のみ                              │
└──────────────────────────────────────────────────────────────┘

  メール送信: Brevo Free (300通/日)
  Cron 実行: cron-job.org (外部、無料、§5 で詳述)
  CI/CD: GitHub Actions (無料枠: 2,000分/月)
  ドメイン: Netlify サブドメイン (*.netlify.app)
```

#### PostgreSQL 拡張 (as-built)

実 Supabase (PostgreSQL 16 系) で有効化済の拡張 (= migration で `CREATE EXTENSION` 実行済):

| 拡張 | 用途 | 投入元 migration |
|---|---|---|
| `vector` (pgvector) | 意味検索の embedding 類似度 (vector(1024) 列: knowledges / memos / attachments / faq_embeddings / guide_embeddings の `content_embedding`) | `20260502_pgvector_embedding` |
| `pg_trgm` | 全文検索 / あいまい一致 (`gin_trgm_ops` GIN index)。`SEARCH_PROVIDER=pg_trgm` の実体 | `20260419_project_process_tags_and_suggestion` |

> 他に Supabase 既定の `pgcrypto` / `uuid-ossp` (id 既定 `gen_random_uuid()`) / `pg_stat_statements` / `supabase_vault` / `plpgsql` が introspection で確認されている。詳細なテーブル/index/RLS の as-built は [DATA_MODEL.md](./DATA_MODEL.md) を参照。

#### 月額コスト

| コンポーネント | サービス | 月額 |
|---|---|---|
| アプリケーション | **Netlify Personal** ($9/seat/month) | **$9** |
| データベース | Supabase Free (500MB) | $0 |
| メール送信 | Brevo Free (300通/日) | $0 |
| Cron 実行 | cron-job.org (Free) | $0 |
| CI/CD | GitHub Actions (Public リポは無制限・無料) | $0 |
| ドメイン | 独自ドメイン (`tasukiba.com`、Cloudflare Registrar) | 約 $10.46/年 |
| **合計** | | **約 $9/月 + LLM / Voyage 従量** |

#### 無料枠の制約と対策

| 制約 | 影響 | 対策 |
|---|---|---|
| Netlify Personal: **統合 credits 1,000/月** (1 deploy = ~15、約 65 deploy/月相当) | PR / 本番 deploy を量産すると逼迫、超過で**新規 deploy 停止** (`no overage charges ever` = 課金されない代わりにサービス停止) | `scripts/netlify-ignore.sh` で docs-only 変更を skip、ローカル `pnpm dev` 中心の開発。残 200 切ったら Pro/Business 移行判断 (DEPLOYMENT.md §8.2 参照) |
| Netlify Personal: Function 10 秒 (Sync 固定、Background Functions は Pro 以上限定) | Bulk LLM 処理がタイムアウト | 分割実行で 10 秒以内に収める ([feedback_bulk_llm_call_unit](../knowledge/) 参照)、または Pro 以上に昇格して Background Functions (15 分) を利用 |
| Netlify Personal: 日本リージョン未対応 | 日本ユーザに +50-150ms latency | 許容 (将来 Edge Functions / 独自 CDN で改善) |
| Supabase Free: 500MB | 約3年で逼迫（ログ制御後） | ログ保持期間の厳格化で 5 年以上対応可 |
| Supabase Free: 1週間無操作で停止 | 長期休暇時にDBが停止 | cron-job.org の health-check で日次アクセス維持 |
| Supabase Free: Pooler 経由のみ | Prisma の一部機能に制約 | Transaction mode + `?pgbouncer=true` を使用 (`DATABASE_URL`) |
| Brevo Free: 300通/日 | 初期フェーズでは十分 | ユーザ増加時に Starter ($9/月) へ移行 |

#### データ量の見積もり（ログ制御後）

| 期間 | ビジネスデータ | 監査ログ | 合計 | 500MB に対する使用率 |
|---|---|---|---|---|
| 1年後 | ~8MB | ~36MB | ~44MB | 9% |
| 3年後 | ~24MB | ~36MB（1年保持で削除） | ~60MB | 12% |
| 5年後 | ~40MB | ~36MB（1年保持で削除） | ~76MB | 15% |

※ operation_trace_logs を初期フェーズで無効化し、audit_logs は 1 年保持で物理削除する前提

### 10.3 将来の有料構成（スケール時）

ユーザ数増加・本格運用移行時は以下の構成に段階的に移行する (現行は Netlify Personal $9/月)。

| トリガー | 移行先 | 追加コスト (現行 Personal 比) |
|---|---|---|
| 統合 credits 1,000/月 逼迫 (= deploy 65回超) or Background Functions (15分処理) が必要 | Netlify Pro (1,000 credits/月 + Function 26 秒 + Background Functions + role-based access) | +$10/月 (Personal $9 → Pro $19) |
| 日本リージョンでの低 latency が必要 | AWS (ap-northeast-1) / GCP (asia-northeast1) への移行 | 要別途見積もり |
| DB 500MB 超過 or 直接接続が必要 | Supabase Pro | +$25/月 |
| メール 300通/日超過 | Brevo Starter | +$9/月 |
| 独自ドメインが必要 | ドメイン取得 | +~$1/月 |
| 大規模運用（100名超） | AWS / Azure への移行 | 要別途見積もり |

### 10.4 環境変数一覧

> **環境変数の真実源は [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md)** (2026-05-30 に env doc を一本化、旧 `docs/operations/ENV_VARS.md` は archive)。
> 全 env の用途・context 別実値・取得方法・Stripe Price 対応は同書を参照。本節はインフラ接続に直結する DB 接続 2 系統のみ補足する。

#### 環境別の DATABASE_URL / DIRECT_URL

| 環境 | DATABASE_URL (アプリ実行) | DIRECT_URL (migration) |
|---|---|---|
| 自社 (Supabase、本番) | Pooler 経由 (ポート **6543**, Transaction mode, `?pgbouncer=true`) | 直結 (ポート **5432**, Session mode) |
| ローカル開発 (Docker) | `postgresql://postgres:postgres@localhost:5433/tasukiba` | DATABASE_URL と同一 |

> migration は pooler だと advisory lock が取れないため **DIRECT_URL (5432 直結) が必須**。
> アプリ実行は接続数抑制のため pooler (6543)。Netlify build は `pnpm build:netlify` で `prisma migrate deploy` を DIRECT_URL 経由で実行する (`netlify.toml` / `scripts/netlify-build.sh`)。

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
| 送信元アドレス | 環境変数 MAIL_FROM で設定（本番: noreply@tasukiba.com、受信不能の自動送信専用。問合せ窓口は LP contact form に集約） |

### 18.5 環境変数

| 変数名 | 説明 | 例 |
|---|---|---|
| RESEND_API_KEY | Resend の API キー | re_xxxxxxxxxx |
| MAIL_FROM | 送信元メールアドレス | noreply@tasukiba.com (受信不能の自動送信専用) |

---


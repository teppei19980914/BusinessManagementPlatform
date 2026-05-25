# 環境変数一覧 (Operations)

本ドキュメントは、本サービスの全環境変数を一覧化する (OPERATION.md §1 を転記)。デプロイ手順は [DEPLOYMENT.md](./DEPLOYMENT.md)、ローカル起動は [SETUP_LOCAL.md](./SETUP_LOCAL.md) を参照。

---

## 1. 環境変数一覧

`.env.example` に定義されている全変数。ローカル開発は `cp .env.example .env` して編集する。
本番・ステージングは **Netlify Dashboard → Site configuration → Environment variables** に設定する (2026-05-18 Vercel から Netlify へ移行済)。

> ★必須★ env var の中には **Production / Deploy preview / Branch deploys / Local development の deploy context ごとに別値を設定すべきもの** がある (`NEXTAUTH_URL`, `STRIPE_*` 系等)。全 context 共通設定だと本番事故 (Stripe 本番カードへの誤課金、Deploy Preview から本番 URL へのリダイレクト等) に直結するため、**§2 の context 別設定マトリクスを必ず確認** すること。

### 1.1 ポート設定

| 変数名 | 既定値 | 用途 | 取得方法 |
|---|---|---|---|
| `APP_PORT` | `3000` | Next.js 開発サーバが待ち受けるポート | 既存プロセスと衝突時のみ変更 |
| `DB_PORT` | `5433` | ローカル PostgreSQL (Docker) の公開ポート | 同上 (5432 は OS 既存 PG と衝突しやすいため既定で 5433) |

### 1.2 データベース

| 変数名 | 例 | 用途 |
|---|---|---|
| `DB_NAME` | `tasukiba` | ローカル DB の DB 名 |
| `DB_USER` | `postgres` | ローカル DB のユーザ名 |
| `DB_PASSWORD` | `postgres` | ローカル DB のパスワード |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5433/tasukiba` (ローカル) / `postgresql://postgres.[ref]:[password]@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true` (Supabase) | アプリが実行時に接続する DB。Supabase 利用時は **Pooler (ポート 6543)** を使う |
| `DIRECT_URL` | `postgresql://postgres:postgres@localhost:5433/tasukiba` (ローカル) / `postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres` (Supabase) | Prisma が migration で使う直結 URL。Supabase 利用時は `db.[ref].supabase.co:5432` |

> **なぜ 2 つ必要か**: Prisma の migration は lock を取るため pooler 経由だと動かない。アプリ実行は pooler 経由で接続数を抑える。

**Supabase の接続文字列取得方法** (要確認で検証)

1. Supabase ダッシュボードでプロジェクトを開く
2. **Project Settings → Database → Connection String** を開く
3. **Transaction mode (pooler)** の URI を `DATABASE_URL` に設定
4. **Session mode (direct)** の URI を `DIRECT_URL` に設定

### 1.3 アプリケーション

| 変数名 | 例 | 用途 | 取得方法 |
|---|---|---|---|
| `NEXTAUTH_URL` | `http://localhost:3000` (ローカル) / `https://tasukiba.netlify.app` (Netlify Production のみ) | NextAuth がリダイレクト先の URL 解決に使う | Production は固定 URL。**Deploy preview / Branch deploys では未設定 (Delete) にして trustHost フォールバックを使う** (§2 参照、KDD §5.X+101) |
| `NEXTAUTH_SECRET` | (32 バイトのランダム文字列) | JWT の署名鍵 | ```openssl rand -base64 32``` で生成 |

> **ローテーション時の注意**: `NEXTAUTH_SECRET` を変更すると全ユーザのセッション JWT が即時無効化され、強制的に再ログインとなる。
>
> **セッション有効期限** (`src/config/security.ts` の `SESSION_JWT_MAX_AGE_SEC`): **9 時間**
>   (PR #124 で 24h→9h 短縮)。日本の通常就業時間 (8h + 休憩 1h) を超えて無操作なら強制ログアウト。
>   NextAuth JWT 戦略は各リクエストで token を再署名する sliding 挙動のため、実質「最後の操作から 9 時間」。
>
> **NEXTAUTH_URL の context 分離 (PR #425 / KDD §5.X+101 / 2026-05-22)**:
>   - **Production**: `https://tasukiba.netlify.app` (固定)
>   - **Deploy preview / Branch deploys**: **未設定** (= Netlify Dashboard 上で値を空に保存)
>     → NextAuth v5 が `trustHost: true` でリクエスト host header から base URL を動的に決定する。
>   - **全 context 共通で本番 URL を入れると、Deploy Preview → 本番 URL に即リダイレクトされ UAT 不能になる**。
>   - **`scripts/netlify-build.sh` 内で `export NEXTAUTH_URL=...` するのは無効** (Next.js が `NEXT_PUBLIC_*` 以外の env を bundle に焼かないため Function runtime に届かない / 再追加禁止コメントあり)。
>   - 設定操作は [`DEPLOYMENT.md §2.3`](./DEPLOYMENT.md) を参照。
>
> **Cookie sameSite 設定** (`src/lib/auth.config.ts`): **`'lax'`** を維持 (PR #425 / KDD §5.X+103 で `'strict'` → `'lax'` に再緩和)。Stripe Checkout コールバックで session 切れを起こさないため。env var ではないが「セキュリティ強化」と称して `'strict'` に戻さないこと (= 請求 invariant 破壊)。

### 1.4 メール送信

| 変数名 | 値 | 用途 |
|---|---|---|
| `MAIL_PROVIDER` | `console` / `brevo` / `resend` / `inbox` | 送信方法の切替 (`console` は実送信せずコンソールへ出力、`inbox` は E2E 専用でファイル出力) |
| `MAIL_FROM` | `noreply@example.com` | 送信元アドレス (Brevo / Resend 共通) |
| `MAIL_FROM_NAME` | `たすきば` | 送信元表示名 (Brevo のみ使用) |
| `BREVO_API_KEY` | `xkeysib-xxxxx...` | Brevo API キー (`MAIL_PROVIDER=brevo` 時、**本番既定**)。取得: <https://app.brevo.com/settings/keys/api>。送信元アドレスは Brevo ダッシュボードで事前検証必須 |
| `RESEND_API_KEY` | `re_xxxxx...` | Resend API キー (`MAIL_PROVIDER=resend` 時、代替選択肢)。取得: <https://resend.com/api-keys>。ドメイン未検証時はオーナーメール以外に送信不可 |
| `INBOX_DIR` | `/tmp/tasukiba-e2e-inbox` | 送信内容の JSON 書き出し先 (`MAIL_PROVIDER=inbox` 時、E2E 専用、本番では使わない) |

> **本番推奨**: `brevo` (無料 300 通/日、`.env.example` で ★推奨 明示)
>
> **注**: 過去ドキュメントに `MAIL_PROVIDER=smtp` + `SMTP_HOST/PORT/USER/PASS` の記載があったが、
> 現行コードの `createMailProvider()` (`src/lib/mail/index.ts`) は `smtp` ケースを持たない。
> 指定した場合 `default` 分岐で `console` にフォールバックする (横展開漏れのため PR #123 で docs から削除)。

### 1.5 初期管理者 (シード用)

| 変数名 | 値 | 用途 |
|---|---|---|
| `INITIAL_ADMIN_EMAIL` | `admin@example.com` | `pnpm db:seed` で作成する初期管理者のメール |
| `INITIAL_ADMIN_PASSWORD` | **10 文字以上 + 英大文字・英小文字・数字・記号のうち 3 種以上** | 初期管理者のパスワード。初回ログイン時に強制変更 |

> パスワードポリシー検証は `prisma/seed.ts` で実施している (`./prisma/seed.ts:36-45`)。条件を満たさないと seed が失敗する。

### 1.6 その他

| 変数名 | 既定値 | 用途 |
|---|---|---|
| `SEARCH_PROVIDER` | `pg_trgm` | 全文検索プロバイダ切替 (現状 pg_trgm のみ実装、要確認) |
| `ENABLE_OPERATION_TRACE` | `false` | 操作トレースの有効化フラグ (要確認: 詳細は DESIGN.md) |
| `CRON_SECRET` | (任意のランダム文字列) | Vercel Cron から `/api/admin/users/lock-inactive` 等を叩く際の `Authorization: Bearer` で使用。**未設定の場合 cron は実行されない** (手動実行は admin ログインで可能)。PR #89 で 30 日非アクティブユーザに使用 (feat/account-lock 改修で **論理削除 → ロック (isActive=false)** に方針変更)。 |

### 1.6-ter メール送信モニタ (P-H / 2026-05-08 追加)

| 変数名 | 既定値 (未設定時) | 用途 |
|---|---|---|
| `EMAIL_DAILY_LIMIT` | `300` (= Brevo 無料プラン) | super_admin ダッシュボードの「メール送信モニタ」カードでしきい値判定に使用。日次の送信件数がこの値に達すると以降の送信を自動ブロック (`daily_limit_exceeded`)。プロバイダ変更時は本値を上書き。 |
| `EMAIL_MONTHLY_LIMIT` | `null` (= 制限なし) | 月次上限がある プロバイダ (Resend free 3000/月 等) で指定。`null` なら月次集計表示のみで送信ブロックには使わない (= 日次上限のみで運用)。 |

**プロバイダ別の参考値**:

| プロバイダ | プラン | 設定例 |
|---|---|---|
| Brevo Free | 300 通/日 | デフォルト |
| Brevo Starter ($9/月) | 5000 通/月 | `EMAIL_DAILY_LIMIT=20000` (実質無制限) + `EMAIL_MONTHLY_LIMIT=5000` |
| Resend Free | 100 通/日, 3000 通/月 | `EMAIL_DAILY_LIMIT=100` + `EMAIL_MONTHLY_LIMIT=3000` |
| AWS SES | 実質無制限 | `EMAIL_DAILY_LIMIT=100000` (= 大きな値) |

**設計意図**: ベンダー側の送信上限超過は招待・パスワードリセット等の重要メールが消失するため、超過する**前**に super_admin ダッシュボードで気付く設計。80% で warn / 90% で alert / 100% で送信自動ブロック (本体送信を止めて recordError 記録 + 自動 retry なし)。

詳細は [src/services/email-send-log.service.ts](../../src/services/email-send-log.service.ts) と [src/config/email-limit.ts](../../src/config/email-limit.ts) 参照。

### 1.6-bis DB 容量モニタ (P-5a / 2026-05-08 追加)

| 変数名 | 既定値 (未設定時) | 用途 |
|---|---|---|
| `DB_CAPACITY_LIMIT_BYTES` | `524288000` (= Supabase Free プラン 500 MB) | super_admin ダッシュボードの DB 容量カードでしきい値判定に使用。プランをアップグレードした際は本値を上書きするだけで再デプロイ不要。 |

**Supabase プラン別の参考値** (公式 https://supabase.com/pricing 2026-05 時点):

| プラン | 上限 | 設定値 |
|---|---|---|
| Free | 500 MB | `524288000` (デフォルト) |
| Pro | 8 GB | `8589934592` |
| Team | 500 GB | `549755813888` |

**設計意図**: Supabase Management API を使わず `pg_database_size()` で実測する方針。Personal Access Token 取得が不要・移植性が高い・テーブル別内訳も同時取得可。閾値は **80% で warn / 90% で alert** の 3 段階分類で表示色が変化。

詳細は [src/services/db-capacity.service.ts](../../src/services/db-capacity.service.ts) と [src/config/db-capacity.ts](../../src/config/db-capacity.ts) 参照。

### 1.7 i18n (タイムゾーン / ロケール既定値) — PR #118 追加

| 変数名 | 既定値 (未設定時) | 用途 |
|---|---|---|
| `APP_DEFAULT_TIMEZONE` | `Asia/Tokyo` | システム全体のデフォルトタイムゾーン (IANA 名)。ユーザ個別設定 (`User.timezone`) が未設定の全ユーザに適用される。オンプレミス / クラウド拠点ごとに設定する想定 (例: `America/New_York`, `Europe/London`, `UTC`)。 |
| `APP_DEFAULT_LOCALE` | `ja-JP` | システム全体のデフォルトロケール (BCP 47)。対応は `src/config/i18n.ts` の `SUPPORTED_LOCALES` を参照。新規ロケール追加には `src/i18n/messages/<locale>.json` (PR #120 予定) も必要。 |

**設計意図**: DB は常に UTC で格納し (`timestamptz`)、描画時にタイムゾーンを解決する方針。
3 段階フォールバック: **ユーザ個別設定 → システムデフォルト (env) → FALLBACK (config)**。

**設定例** (米国東部拠点でのオンプレ展開):

```bash
# .env.production
APP_DEFAULT_TIMEZONE=America/New_York
APP_DEFAULT_LOCALE=en-US
```

詳細は [developer/DEVELOPER_GUIDE.md §10.8](../developer/DEVELOPER_GUIDE.md#108-タイムゾーン--ロケールの-3-段階フォールバック-pr-118) 参照。

### 1.8 コミュニティ・コンタクトリンク (#16 / PR I 2026-05-09)

| 変数名 | 既定値 (未設定時) | 用途 |
|---|---|---|
| `NEXT_PUBLIC_DISCORD_INVITE_URL` | `https://discord.com/invite/EqY82YvxuG` (公式コミュニティ) | ヘッダ右側の「開発者と話す (Discord)」ボタンと、`/help` 末尾の連絡先 CTA に使用。値を `disabled` または空文字にすると UI から非表示にできる。別環境で異なる Discord サーバを使う場合のみ上書き。 |
| `NEXT_PUBLIC_FEATURE_REQUEST_URL` | (未設定) | 機能要望・案件依頼の専用リンク。Discord フォーラムチャンネル等。未設定なら一般 Discord (`NEXT_PUBLIC_DISCORD_INVITE_URL`) にフォールバック。 |

**設計意図**: 招待 URL は **クライアントに見える** 前提なので機密ではなく、ハードコード既定値で「ゼロ設定で動く」状態を担保。一方、別環境で別 URL を使いたい運営は env で上書き可能。`NEXT_PUBLIC_*` プレフィックスで client/server 両方から参照可能。

詳細は [src/config/community.ts](../../src/config/community.ts) 参照。

### 1.9 Stripe Metered Billing 連携 (v1.x / PR-S2 以降)

| 変数名 | 既定値 (未設定時) | 用途 |
|---|---|---|
| `STRIPE_ENABLED` | `false` | **feature flag**。値が文字列 `'true'` (大小区別) の場合のみ機能を有効化 (UI 表示、API 受付、Webhook 処理)。それ以外 (未設定 / `'false'` / 任意文字列) は OFF。`'1'` や bool は不可。判定実装: [`src/lib/stripe.ts`](../../src/lib/stripe.ts) の `isStripeEnabled()` |
| `STRIPE_SECRET_KEY` | (未設定) | Stripe API キー (= サーバサイド)。**Test mode = `sk_test_xxx` / Live mode = `sk_live_xxx`**。Stripe Dashboard → Developers → API keys から取得。**絶対に GitHub にコミットしない**。Production context のみ Live key、Deploy preview / Branch deploys / Local は必ず Test key |
| `STRIPE_WEBHOOK_SECRET` | (未設定) | Stripe Webhook の署名検証用 secret (`whsec_xxx`)。Stripe Dashboard → Developers → Webhooks → 該当エンドポイント詳細から取得。**Test / Live で必ず別エンドポイントを作成**し、それぞれの secret を context 別に設定 |
| `STRIPE_PRICE_HAIKU` | (未設定) | Expert per-call (Haiku) の Price ID (`price_xxx`)。Stripe Dashboard → Products で事前作成 (= **単価 ¥10、Metered**、ADR-0019 / 2026-05-24 改定: ¥5 → ¥10)。**ADR-0019 後の運用作業: 新 Price ID への切替が必要**、詳細 [STRIPE_SETUP.md](./STRIPE_SETUP.md)。Test / Live で別 Price ID |
| `STRIPE_PRICE_SONNET` | (未設定) | Pro per-call (Sonnet) の Price ID。**¥15/call、Metered** (据置)。Test / Live で別 |
| `STRIPE_PRICE_STORAGE_PLUS` | (未設定) | Storage Plus add-on の Price ID。¥500/月、Recurring 固定。Test / Live で別 |
| `STRIPE_PRICE_STORAGE_PRO` | (未設定) | Storage Pro add-on の Price ID。¥1,500/月、Recurring 固定。Test / Live で別 |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | (未設定) | Stripe Publishable Key (= ブラウザ側で使用、機密情報ではない)。**Test mode = `pk_test_xxx` / Live mode = `pk_live_xxx`**。Stripe Elements / Checkout で使用。SECRET_KEY とペアで context 別に切替 |
| `SYSTEM_USER_ID` | (未設定) | 自動操作 (Webhook ハンドラ / cron) で auditLog の `userId` に記録するシステムユーザ UUID。専用 seed (= `system@internal`、`isActive=false`) で作成済 |

**設計意図**:
- `STRIPE_ENABLED=false` (default) でデプロイすれば、コードはマージ済でも顧客には機能が見えない (= 段階的ロールアウト)
- Stripe Dashboard 設定が完了 + 動作確認 OK のテナントで初めて `STRIPE_ENABLED=true` に切替
- テスト/本番でキーを厳密分離し、`STRIPE_SECRET_KEY` の値 (sk_test / sk_live) で Stripe SDK が自動的に環境を判別
- **Deploy preview でも `STRIPE_ENABLED=true` + Test key 一式** をセットしておくと、PR Deploy Preview 上で TC が完走できる (PR #425 TC 実行時の運用)
- **Production / Deploy preview で同じ Live key を使う事故** は致命 (= 本番カードに誤課金) のため、context override 必須

**context 別設定マトリクス**: §2 参照。

**設定手順詳細**: [docs/operations/STRIPE_SETUP.md](./STRIPE_SETUP.md)
**仕様詳細**: [docs/business/STRIPE_BILLING.md](../business/STRIPE_BILLING.md) §7.2
**実装詳細**: [docs/design/STRIPE_TECHNICAL_DESIGN.md](../design/STRIPE_TECHNICAL_DESIGN.md) §E-3

> **関連**: PR #425 / KDD §5.X+99, §5.X+100, §5.X+103 (Stripe 堅牢性系列) / `feedback_billing_invariant`

---

### 1.10 super_admin 画面 Basic Auth (PR-V7 / 2026-05-19 / クレ協 1.1 対応)

割賦販売法に基づくクレジット取引セキュリティ対策協議会 (クレ協) チェックリスト 1.1
「管理者画面のアクセス制限」要件への対応。Stripe 申請時の必須セキュリティ対策。

| 環境変数 | 既定値 | 用途 |
|---|---|---|
| `ADMIN_SUPER_BASIC_AUTH_USER` | (未設定) | `/admin/super/*` および `/api/admin/super/*` 配下に適用される Basic Auth のユーザ名。例: `admin` |
| `ADMIN_SUPER_BASIC_AUTH_PASS` | (未設定) | 同 Basic Auth のパスワード。**32 文字以上推奨**。`openssl rand -base64 48` 等で生成 |

**動作**:
- 両方 set → Basic Auth 有効 (= super_admin 画面アクセス時にブラウザがプロンプト表示)
- 両方 unset → Basic Auth 無効 (= 開発 / E2E モード、既存挙動維持)
- 片方のみ set → fail-closed (= 設定ミス検知用に絶対通らない状態へ)

**設計意図**:
- 多層防御: Basic Auth (本層) + NextAuth セッション + super_admin role gate の 3 段
- Edge runtime (middleware) で動作するため Node.js Buffer 不使用、Web 標準 `btoa` を使用
- constant-time 比較でタイミング攻撃を防止

**運用**:
- 個人開発者は **Bitwarden 等のパスワードマネージャに保存** → ロケーション問わずアクセス可
- 失念時は Netlify Dashboard で env 値を再生成 → 再デプロイで反映

**実装**: [src/lib/basic-auth.ts](../../src/lib/basic-auth.ts) / [src/middleware.ts](../../src/middleware.ts)

---

## 2. Deploy context 別設定値マトリクス (Netlify) — PR #425 / KDD §5.X+101, §5.X+103

Netlify Dashboard → Site configuration → Environment variables では **同一 env を deploy context ごとに別値で持てる** (「Different value for each deploy context」)。
誤って全 context 共通設定にすると本番事故 (誤課金、本番 URL リダイレクト等) になるため、以下のマトリクスを基準に必ず分離設定すること。

### 2.1 context 別設定が必須の変数

| 変数名 | Production | Deploy preview | Branch deploys | Local development | 補足 |
|---|---|---|---|---|---|
| `NEXTAUTH_URL` | `https://tasukiba.netlify.app` | **未設定 (Delete)** | **未設定 (Delete)** | `http://localhost:3000` | preview/branch を未設定にすると `trustHost: true` で host header から動的取得。KDD §5.X+101 |
| `NEXTAUTH_SECRET` | (Live secret) | (同左 / Test 用に別でも可) | (同左) | 開発用 secret | Production と preview を分けるとログイン session が context 間で持ち越せない |
| `STRIPE_ENABLED` | `true` (リリース後) | `true` (TC 実行時) | `true` / `false` 任意 | `false` (通常) / `true` (Stripe 確認時) | 値は文字列 `'true'` で評価 |
| `STRIPE_SECRET_KEY` | `sk_live_xxx` | `sk_test_xxx` | `sk_test_xxx` | `sk_test_xxx` | Live を preview に共有すると本番カードに誤課金リスク |
| `STRIPE_WEBHOOK_SECRET` | Live endpoint の `whsec_xxx` | Test endpoint の `whsec_xxx` | Test endpoint の `whsec_xxx` | (Stripe CLI listen で都度発行) | Stripe Dashboard 上で Test / Live は別 endpoint |
| `STRIPE_PRICE_HAIKU` | Live `price_xxx` | Test `price_xxx` | Test `price_xxx` | Test `price_xxx` | Test / Live で Product ごと別 |
| `STRIPE_PRICE_SONNET` | 同上 | 同上 | 同上 | 同上 | 〃 |
| `STRIPE_PRICE_STORAGE_PLUS` | 同上 | 同上 | 同上 | 同上 | 〃 |
| `STRIPE_PRICE_STORAGE_PRO` | 同上 | 同上 | 同上 | 同上 | 〃 |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_live_xxx` | `pk_test_xxx` | `pk_test_xxx` | `pk_test_xxx` | SECRET_KEY とペアで切替 |
| `MAIL_PROVIDER` | `brevo` (実送信) | `console` or `inbox` (=実送信回避) | 任意 | `console` | preview で実送信すると Brevo 無料枠 300/日を浪費 |
| `BREVO_API_KEY` | Live key | (未設定 or sandbox) | (同左) | (未設定) | preview で誤送信防止 |

### 2.2 全 context 共通でよい変数 (= context override 不要)

| 変数名 | 共通値の例 | 補足 |
|---|---|---|
| `DATABASE_URL` | Supabase Transaction Pooler URL | preview も本番と同じ DB を見る (= staging DB なしの単一環境運用)。詳細: [`DEPLOYMENT.md §2.0`](./DEPLOYMENT.md) |
| `DIRECT_URL` | Supabase Session Pooler URL | 同上 (migrate 用) |
| `CRON_SECRET` | (ランダム値) | cron は Production にしか叩かれない想定だが、preview にも同値を設定して動作確認可能にしておく |
| `ADMIN_SUPER_BASIC_AUTH_USER` / `_PASS` | 共通値 | 全 context で `/admin/super/*` 保護 |
| `EMAIL_DAILY_LIMIT` / `EMAIL_MONTHLY_LIMIT` | 共通値 | プロバイダ別の上限値 |
| `DB_CAPACITY_LIMIT_BYTES` | Supabase プラン値 | 共通値 |
| `APP_DEFAULT_TIMEZONE` / `APP_DEFAULT_LOCALE` | 共通値 | 拠点ごとに切替する場合のみ context 分離 |
| `SYSTEM_USER_ID` | 共通値 | seed で生成する単一 UUID |
| `NEXT_PUBLIC_DISCORD_INVITE_URL` / `_FEATURE_REQUEST_URL` | 共通値 | client 側で参照 |

### 2.3 Netlify Dashboard 操作手順 (context override 設定)

詳細は [`DEPLOYMENT.md §2.3`](./DEPLOYMENT.md) を参照。要約:

1. **Site configuration → Environment variables** で対象 env の **Edit** をクリック
2. **"Different value for each deploy context"** をチェック
3. 各 context (Production / Deploy previews / Branch deploys / Local development) ごとに値を入力
   - **空欄保存で undefined として伝播** (= `NEXTAUTH_URL` の trustHost フォールバック発火用)
4. Save → 即時反映 (次回 build 以降に有効)
5. 対象 PR の Deploy Preview を **Trigger deploy** で再 build → 反映確認

CLI 経由 (一例):
```bash
# Production だけ Live key、preview/branch は Test key
netlify env:set STRIPE_SECRET_KEY "sk_live_xxx" --secret --context production
netlify env:set STRIPE_SECRET_KEY "sk_test_xxx" --secret --context deploy-preview
netlify env:set STRIPE_SECRET_KEY "sk_test_xxx" --secret --context branch-deploy

# Production だけ NEXTAUTH_URL を固定、preview/branch は削除 (= trustHost フォールバック)
netlify env:set NEXTAUTH_URL "https://tasukiba.netlify.app" --context production
netlify env:unset NEXTAUTH_URL --context deploy-preview
netlify env:unset NEXTAUTH_URL --context branch-deploy
```

> **関連**: PR #425 / KDD §5.X+99, §5.X+101, §5.X+103 / [`DEPLOYMENT.md §2.3-2.5`](./DEPLOYMENT.md)

---

## 3. 補足 (`build wrapper` 経由の env 注入は不可)

`scripts/netlify-build.sh` 内で `export NEXTAUTH_URL=...` のような env 注入を **行わない**。
理由: Next.js は `NEXT_PUBLIC_*` プレフィックス付きの env のみを build 時に bundle へ焼き込むため、それ以外の env は **build プロセス内に閉じ、Netlify Function runtime (= 別 Lambda 実行環境) には一切伝播しない**。

→ runtime に context 別の値を届けたい場合は **§2.3 の Netlify Dashboard context override が唯一の正解**。

KDD §5.X+101 で実証済み + `scripts/netlify-build.sh` 冒頭に再追加禁止コメントあり。

---


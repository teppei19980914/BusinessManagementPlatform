# 環境変数 as-built インベントリ (Netlify 登録実態 / 2026-05-30)

最終更新: 2026-05-30
ステータス: **as-built 記録** — Netlify Dashboard に実際に登録されている環境変数の棚卸し
関連:
- 仕様・取得方法 (how-to): [docs/operations/ENV_VARS.md](../operations/ENV_VARS.md)
- Stripe Price ↔ env の詳細対応: [STRIPE_ENV_MAPPING.md](./STRIPE_ENV_MAPPING.md)
- Stripe Embedding 改定: [STRIPE_EMBEDDING_PRICE_SETTINGS.md](./STRIPE_EMBEDDING_PRICE_SETTINGS.md)

> **本書の位置づけ**: [ENV_VARS.md](../operations/ENV_VARS.md) が「全 env の仕様・取得方法」を網羅するのに対し、
> 本書は **2026-05-30 時点で Netlify に実際に登録されている値・context・スコープの棚卸し (as-built)** を記録する。
> 値の取り扱い: **🔒 secret スコープ (値が伏字) の変数は値を記載しない**。平文表示される変数のみ Key↔値 を記載する。
> deploy context 略号: **Prod** = Production / **Prev** = Deploy Previews / **Branch** = Branch deploys /
> **PSAR** = Preview Server & Agent Runners / **Local** = Local development (Netlify CLI)。

---

## 1. AI / Embedding API キー (🔒 secret)

| 変数名 | 用途 | 設定 context | 値 |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API キー (LLM = プロジェクト自動タグ・なぜ?機能・ヘルプチャット)。`sk-ant-…` | Prod/Prev/Branch (PSAR/Local 空) | 🔒 記載省略 |
| `VOYAGE_API_KEY` | Voyage AI embedding API キー (提案エンジン・チャット検索・添付索引化の embedding 生成) | Prod/Prev/Branch (PSAR/Local 空) | 🔒 記載省略 |

> 設定値: Anthropic / Voyage コンソールで発行した API キー。本番は Live キー、Prev/Branch は検証用キーを推奨。

## 2. データベース (🔒 secret)

| 変数名 | 用途 | 設定 context | 値 |
|---|---|---|---|
| `DATABASE_URL` | アプリ実行時の DB 接続 (Supabase は **Pooler ポート 6543**)。Prisma Client が使用 | Prod/Prev/Branch (PSAR/Local 空) | 🔒 記載省略 |
| `DIRECT_URL` | Prisma migration 用の直結 URL (Supabase は `db.[ref]:5432`)。pooler だと lock が取れないため別途必要 | Prod/Prev/Branch (PSAR/Local 空) | 🔒 記載省略 |

> 設定値: Supabase → Project Settings → Database → Connection String の Transaction mode (DATABASE_URL) / Session mode (DIRECT_URL)。
> ✅ **既知・現状許容**: 現状ステージング (Prev/Branch) と本番は **同一 DB** を向いている (今後分離予定、§10-3)。分離時に Prev/Branch を staging DB へ切替える。

## 3. 認証 / NextAuth

| 変数名 | スコープ | 用途 | 設定 context | 値 |
|---|---|---|---|---|
| `NEXTAUTH_SECRET` | 🔒 | NextAuth JWT 署名鍵 (+ MFA `mfaSecretEncrypted` の AES 鍵に流用)。`openssl rand -base64 32` | Prod/Prev/Branch (PSAR/Local 空) | 🔒 記載省略 |
| `NEXTAUTH_URL` | 平文 | NextAuth のリダイレクト URL 解決。**Production のみ固定設定**、Prev/Branch は未設定で trustHost フォールバック (ENV_VARS.md §1.3 設計通り) | **Prod のみ** | `https://tasukiba.com` |

## 4. Stripe (決済)

> ✅ **2026-05-30 確認**: 全 `STRIPE_PRICE_*` が **Production = Live Price / Prev・Branch・PSAR・Local = Test Price** で正しく分離設定済み。`STRIPE_ENABLED=true` (credit_card 有効化済)。詳細対応は [STRIPE_ENV_MAPPING.md](./STRIPE_ENV_MAPPING.md)。

| 変数名 | スコープ | 用途 | Production (Live) | Prev/Branch/PSAR/Local (Test) |
|---|---|---|---|---|
| `STRIPE_ENABLED` | 平文 | 機能フラグ (`'true'` で有効)。全 5 context で `true` | `true` | `true` |
| `STRIPE_SECRET_KEY` | 🔒 | サーバ API キー (`sk_live`/`sk_test`)。**Prod/Prev/Branch のみ (PSAR/Local 空)** | 🔒 (sk_live) | 🔒 (sk_test) |
| `STRIPE_WEBHOOK_SECRET` | 🔒 | Webhook 署名検証 (`whsec_`)。Test/Live で別 endpoint。Prod/Prev/Branch のみ | 🔒 | 🔒 |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | 平文 (公開鍵) | ブラウザ用 publishable key。全 5 context | `pk_live_51TXEw…` | `pk_test_51TYb8uK3…` |
| `STRIPE_PRICE_HAIKU` | 平文 | Expert per-call (Haiku) ¥10。Meter `tasukiba_haiku_api_call` | `price_1TcPQVKHIaXKbo0MNGUwQPPq` | `price_1TcLQIK3TUQWW2eqMEBsEFqF` |
| `STRIPE_PRICE_SONNET` | 平文 | Pro per-call (Sonnet) ¥15。Meter `tasukiba_sonnet_api_call` | `price_1TcPRVKHIaXKbo0MW3WityQ5` | `price_1TcLRIK3TUQWW2eqohr0tuUm` |
| `STRIPE_PRICE_EMBEDDING` | 平文 | **Embedding ¥5 (ADR-0029)**。Meter `tasukiba_embedding_call` | `price_1Tchn2KHIaXKbo0M5OYQAQUN` | `price_1TchuCK3TUQWW2eqQ278OqEI` |
| `STRIPE_PRICE_DB_CAPACITY_OVERAGE` | 平文 | DB 容量超過 ¥1/unit (円整数 quantity)。Meter `tasukiba_db_capacity_overage_jpy` | `price_1TcPSCKHIaXKbo0MTtJECpBH` | `price_1TcLTmK3TUQWW2eqDlp4iJGk` |
| `STRIPE_PRICE_STORAGE_FILE_OVERAGE` | 平文 | ファイルストレージ超過 ¥1/unit。Meter `tasukiba_storage_file_overage_jpy` | `price_1TcPSxKHIaXKbo0M22Qz1bTN` | `price_1TcLdlK3TUQWW2eqXU09bsd2` |

## 5. メール送信 (Brevo)

| 変数名 | スコープ | 用途 | 設定 context | 値 |
|---|---|---|---|---|
| `MAIL_PROVIDER` | 平文 | 送信方法切替 (`brevo` 本番既定) | 全 context | `brevo` |
| `MAIL_FROM` | 平文 | 送信元アドレス (受信不能の自動送信専用) | 全 context | `noreply@tasukiba.com` |
| `MAIL_FROM_NAME` | 平文 | 送信元表示名 | 全 context | `たすきば` |
| `BREVO_API_KEY` | 🔒 | Brevo API キー (`xkeysib-…`) | Prod/Prev/Branch (PSAR/Local 空) | 🔒 記載省略 |
| `EMAIL_DAILY_LIMIT` | 平文 | 日次送信上限 (Brevo Free=300)。超過で送信自動ブロック | 全 context | `300` |

## 6. ストレージ (Supabase Storage)

| 変数名 | スコープ | 用途 | 設定 context | 値 |
|---|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | 🔒 | 添付ファイルの Pre-signed URL 発行・bucket 容量集計・cron 削除 (RLS バイパス、絶対に client へ出さない) | **Prod/Prev/Branch** (2026-05-30 ステージング追加済、PSAR/Local 空) | 🔒 記載省略 |
| `SUPABASE_STORAGE_BUCKET` | 平文 | 添付本体を保存する bucket 名 | 全 context | `attachments` |

> ✅ **対応済 (2026-05-30)**: `SUPABASE_SERVICE_ROLE_KEY` を Deploy Previews / Branch deploys に設定済 (Production と同一 Supabase プロジェクトのため同値)。ステージングで添付ファイル機能が稼働可能に。

## 7. 初期管理者 / Super Admin (シード + Basic Auth)

| 変数名 | スコープ | 用途 | 設定 context | 値 |
|---|---|---|---|---|
| `INITIAL_ADMIN_EMAIL` | 平文 | `pnpm db:seed` の初期管理者メール | 全 context | `admin@example.com` |
| `INITIAL_ADMIN_PASSWORD` | 🔒 | 初期管理者パスワード (初回ログインで強制変更) | Prod/Prev/Branch (PSAR/Local 空) | 🔒 記載省略 |
| `SUPER_ADMIN_INITIAL_EMAIL` | 平文 | seed の super_admin メール | 全 context | `super@example.com` |
| `SUPER_ADMIN_INITIAL_NAME` | 平文 | seed の super_admin 表示名 | 全 context | `Super Admin` |
| `SUPER_ADMIN_INITIAL_PASSWORD` | 🔒 | seed の super_admin パスワード | Prod/Prev/Branch (PSAR/Local 空) | 🔒 記載省略 |
| `ADMIN_SUPER_BASIC_AUTH_USER` | 平文 | `/admin/super/*` の Basic Auth ユーザ名 | 全 context | `admin` |
| `ADMIN_SUPER_BASIC_AUTH_PASS` | 🔒 (2026-05-30 secret 化済) | `/admin/super/*` の Basic Auth パスワード | Prod/Prev/Branch/PSAR (Local 空) | 🔒 記載省略 |

## 8. cron / システム / 運用

| 変数名 | スコープ | 用途 | 設定 context | 値 |
|---|---|---|---|---|
| `CRON_SECRET` | 🔒 | 外部 cron (cron-job.org) → `/api/cron/*` の `Authorization: Bearer` 検証。未設定だと cron 実行されない | Prod/Prev/Branch (PSAR/Local 空) | 🔒 記載省略 |
| `SYSTEM_USER_ID` | 平文 | cron/Webhook の auditLog `userId` に記録する system ユーザ UUID (seed 生成済) | 全 context | `63cf718f-98cf-4882-9d6d-286441607d16` |
| `NETLIFY_API_TOKEN` | 🔒 | Netlify API トークン (env 管理・デプロイ操作等) | Prod/Prev/Branch (PSAR/Local 空) | 🔒 記載省略 |
| `NETLIFY_SITE_ID` | 平文 | Netlify サイト ID | 全 context | `ecff671c-6346-468a-a332-b21dc458d1f3` |

## 9. アプリ既定値 / ビルド

| 変数名 | 用途 | 設定 context | 値 |
|---|---|---|---|
| `APP_DEFAULT_LOCALE` | システム既定ロケール (BCP 47)。ユーザ未設定時に適用 | 全 context | `ja-JP` |
| `APP_DEFAULT_TIMEZONE` | システム既定タイムゾーン (IANA)。ユーザ未設定時に適用 | 全 context | `Asia/Tokyo` |
| `SEARCH_PROVIDER` | 全文検索プロバイダ (現状 pg_trgm のみ実装) | 全 context | `pg_trgm` |
| `ENABLE_OPERATION_TRACE` | 操作トレース有効化フラグ | 全 context | `false` |
| `NODE_VERSION` | ビルド時 Node.js バージョン | 全 context | `22` |

---

## 10. 気になる点・認識齟齬 (2026-05-30 棚卸しで検出)

### ✅ 整合を確認できた点
- **全 `STRIPE_PRICE_*` (5 本) が Production=Live / その他=Test で正しく分離**。`STRIPE_PRICE_EMBEDDING` も ¥5 Price を指しており、credit_card embedding 課金 (ADR-0029) が env まで疎通。
- `NEXTAUTH_URL` が Production のみ・他 context 未設定 = ENV_VARS.md §1.3 の trustHost 設計通り。
- `STRIPE_ENABLED=true` (credit_card 有効化済の実態と一致)。

### 🟡 要確認・改善余地 (2026-05-30 ユーザ確認結果を反映)
1. **`STRIPE_ENABLED` と `STRIPE_SECRET_KEY` の context 非対称** (旧: ENABLED 5 / KEY 3、PSAR/Local 鍵なし)。
   - **✅ 対応済 (2026-05-30)**: 鍵の無い **Preview Server & Agent Runners / Local development** の `STRIPE_ENABLED` を `false` に変更。フラグと鍵の有無が一致し、`getStripe()` の潜在 throw を解消。Prod/Prev/Branch は `true` (鍵あり) を維持。
2. **`SUPABASE_SERVICE_ROLE_KEY` が Production のみ** → Prev/Branch (ステージング) で添付ファイル機能が動作不可。
   - **✅ 対応済 (2026-05-30、ユーザ実施)**: Deploy Previews / Branch deploys に設定 (Production と同一 Supabase プロジェクトのため同値)。ステージングで添付機能が稼働。インフラ分離時に staging プロジェクトのキーへ差し替え。
3. **`DATABASE_URL` / `DIRECT_URL` が Prod/Prev/Branch の 3 context に値あり**。
   - **✅ 既知・現状許容 (ユーザ確認済)**: 現状ステージングと本番は **同一 DB** を向いている。今後分離予定のため、現状は同値で問題なし。分離時に Prev/Branch を staging DB に切替える。
4. **`ADMIN_SUPER_BASIC_AUTH_PASS`** の secret スコープ化 + 強化。
   - **✅ 対応済 (2026-05-30)**: secret スコープ化済 (4 context、Local 空)。本書もマスキング済 (§7)。なお `ADMIN_SUPER_BASIC_AUTH_USER=admin` は引き続き平文・推測容易のため、必要なら変更検討。
5. **環境変数ドキュメントの一本化 (ユーザ決定・2026-05-30 実施)**: 旧 `docs/operations/ENV_VARS.md` の固有 how-to を本書 §11〜§13 に統合し、本体は `docs/archive/ENV_VARS.md` へ移動。旧パスは本書を指すリダイレクト tombstone を残置 (= 既存 23 ファイルの参照リンク破損を防止)。**以後、環境変数の正は本書**。
6. **`INITIAL_ADMIN_EMAIL=admin@example.com` / `SUPER_ADMIN_INITIAL_EMAIL=super@example.com`** が `example.com` のまま (seed 専用、初回ログインで変更前提)。本番管理者メールとして受信可能アドレスにするか要確認 (優先度低)。

---

## 11. 取得方法・運用注意・プロバイダ参考値 (旧 ENV_VARS.md より統合)

### 11.1 キー取得元
| 変数 | 取得元 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic Console → API keys |
| `VOYAGE_API_KEY` | Voyage AI ダッシュボード |
| `STRIPE_SECRET_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe Dashboard → Developers → API keys (`sk_`/`pk_`、Test/Live で別) |
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Developers → Webhooks → 該当 endpoint (`whsec_`、Test/Live で別 endpoint) |
| `STRIPE_PRICE_*` | Stripe Dashboard → Products (§4 / STRIPE_ENV_MAPPING.md に実 Price ID) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` (RLS バイパス、client へ出さない) |
| `DATABASE_URL` / `DIRECT_URL` | Supabase → Database → Connection String。**DATABASE_URL=Transaction pooler (6543)** / **DIRECT_URL=Session/direct (5432)**。migration は lock のため direct 必須、アプリ実行は pooler で接続数抑制 |
| `BREVO_API_KEY` | <https://app.brevo.com/settings/keys/api> (送信元アドレスは Brevo で事前検証必須) |

### 11.2 ★severity-high★ `NEXTAUTH_SECRET` ローテーション時の MFA 復号不能
`NEXTAUTH_SECRET` 変更で全 JWT 失効 (強制再ログイン) に加え、**MFA 有効ユーザの `mfaSecretEncrypted` が復号不能** になり TOTP 認証時に 500 (`bad decrypt`)。[src/services/mfa.service.ts](../../src/services/mfa.service.ts) の AES-256-CBC が `NEXTAUTH_SECRET` 先頭 32 文字を鍵に流用しているため。ローテーション時は MFA ユーザ事前一覧化 → 告知 → 変更 → `mfa_secret_encrypted` を NULL 化 → 再 setup 依頼の手順を厳守 ([MAINTENANCE_OPERATIONS.md §2.2](../operations/MAINTENANCE_OPERATIONS.md))。セッション有効期限は `src/config/security.ts` `SESSION_JWT_MAX_AGE_SEC` = 9h。Cookie sameSite は `'lax'` 維持 (Stripe Checkout コールバックの session 切れ防止、`'strict'` に戻さない)。

### 11.3 メール送信プロバイダ参考値
| プロバイダ | 設定例 |
|---|---|
| Brevo Free (本番既定) | `EMAIL_DAILY_LIMIT=300` |
| Brevo Starter | `EMAIL_DAILY_LIMIT=20000` + `EMAIL_MONTHLY_LIMIT=5000` |
| Resend Free | `EMAIL_DAILY_LIMIT=100` + `EMAIL_MONTHLY_LIMIT=3000` (`MAIL_PROVIDER=resend` + `RESEND_API_KEY`) |
80% warn / 90% alert / 100% 送信自動ブロック。`MAIL_PROVIDER` は `console`(出力のみ)/`brevo`/`resend`/`inbox`(E2E)。

### 11.4 DB 容量モニタ参考値
`DB_CAPACITY_LIMIT_BYTES`: Supabase Free=`524288000`(500MB、既定)/ Pro=`8589934592`(8GB)。80% warn / 90% alert。`SUPABASE_COMPUTE_SIZE`(micro/small/medium/large)で `DB_INSTANCE_ALERT_THRESHOLD_BYTES` 既定が連動。

### 11.5 super_admin Basic Auth (クレ協 1.1 対応)
`ADMIN_SUPER_BASIC_AUTH_USER` / `_PASS` で `/admin/super/*` を保護 (多層防御: Basic Auth + NextAuth + role gate)。両 set で有効 / 両 unset で無効 / 片方のみ set は fail-closed。Edge runtime で `btoa` + constant-time 比較。実装: [src/lib/basic-auth.ts](../../src/lib/basic-auth.ts) / [src/middleware.ts](../../src/middleware.ts)。**本番は 32 文字以上 + secret スコープ** (env-4 で対応済)。

## 12. Deploy context 別設定マトリクス + Netlify 設定手順

> 同一 env を context ごとに別値で持てる (「Different value for each deploy context」)。全 context 共通設定だと本番事故 (誤課金 / 本番 URL リダイレクト) になるため必ず分離。

### 12.1 context 分離が必須の変数
| 変数 | Production | Deploy preview / Branch | Local |
|---|---|---|---|
| `NEXTAUTH_URL` | `https://tasukiba.com` | **未設定 (Delete → trustHost フォールバック)** | `http://localhost:3000` |
| `STRIPE_SECRET_KEY` | `sk_live_` | `sk_test_` | `sk_test_` |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_live_` | `pk_test_` | `pk_test_` |
| `STRIPE_WEBHOOK_SECRET` | Live endpoint | Test endpoint | Stripe CLI |
| `STRIPE_PRICE_*` (5 本) | Live Price ID | Test Price ID | Test Price ID |
| `STRIPE_ENABLED` | `true` | preview=`true`(TC)/branch 任意 | **PSAR/Local=`false`** (鍵なし、env-1 で対応済) |
| `MAIL_PROVIDER` / `BREVO_API_KEY` | `brevo` + Live key | `console`/`inbox` (実送信回避) | `console` |

### 12.2 全 context 共通でよい変数
`DATABASE_URL`/`DIRECT_URL` (現状 staging=本番 同一 DB、env-3)、`CRON_SECRET`、`SYSTEM_USER_ID`、`EMAIL_DAILY_LIMIT`、`APP_DEFAULT_*`、Discord 系。
**`ANTHROPIC_API_KEY` / `VOYAGE_API_KEY` は全 context 必須 + scope=Builds+Functions+Runtime** (build hook の `generate-faq-embeddings.ts` が build 時に Voyage を使うため。未設定だと意味検索 pg_trgm fallback / ヘルプ degraded)。

### 12.3 Netlify 操作 (Dashboard / CLI)
1. Site configuration → Environment variables → 対象 env **Edit** → 「Different value for each deploy context」→ context ごとに値入力 (空欄保存=undefined 伝播) → Save → 対象 Deploy を再 build。
```bash
netlify env:set STRIPE_SECRET_KEY "sk_live_xxx" --secret --context production
netlify env:set STRIPE_SECRET_KEY "sk_test_xxx" --secret --context deploy-preview
```

## 13. ローカル専用・その他の変数 (Netlify 未登録、`.env.example` 由来)
`APP_PORT`(3000)/ `DB_PORT`(5433)/ `DB_NAME`/`DB_USER`/`DB_PASSWORD`(ローカル Docker DB)/ `RESEND_API_KEY` / `INBOX_DIR`(E2E)/ `EMAIL_MONTHLY_LIMIT`(未設定=制限なし)/ `NEXT_PUBLIC_DISCORD_INVITE_URL` / `NEXT_PUBLIC_FEATURE_REQUEST_URL`。本番で既定値運用の意図なら未登録で問題なし。

# Netlify デプロイ手順 (Operations)

本ドキュメントは、Netlify への本番デプロイ手順を集約する (Vercel から 2026-05-18 に移行)。
障害対応は [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md)、ロールバックは [ROLLBACK.md](./ROLLBACK.md) を参照。

> **移行の背景**: Vercel Hobby プランは規約上商用利用不可のため、6/1 正式リリース (Expert/Pro 課金プラン稼働) に備えて Netlify Starter (商用 OK) へ移行し、その後 credits 制約により Netlify Personal ($9/seat/month) へ昇格した。詳細は [ADR-0023](../adr/0023-netlify-starter-migration.md) と [`docs/design/INFRASTRUCTURE.md §10`](../design/INFRASTRUCTURE.md) を参照。

---

## 1. Netlify 設定ファイル (`netlify.toml`)

リポジトリルートの [`netlify.toml`](../../netlify.toml) で全設定を一元管理。

```toml
[build]
  command = "bash scripts/netlify-build.sh"  # = pnpm build:netlify を実行する薄いラッパー
  publish = ".next"
  ignore = "bash scripts/netlify-ignore.sh"  # docs-only 変更は skip

[build.environment]
  NODE_VERSION = "22"

[[plugins]]
  package = "@netlify/plugin-nextjs"          # Next.js 16 App Router 公式 Runtime
```

> **build wrapper (`scripts/netlify-build.sh`) の現状の役割** (PR #425 / KDD §5.X+101 で訂正済):
> - `pnpm build:netlify` (= `prisma generate && prisma migrate deploy && next build`) を呼び出す薄いラッパー
> - `scripts/netlify-ignore.sh` の path-based skip で「scripts/ 配下の変更」として検出されるためのトリガーファイル兼用
> - **NEXTAUTH_URL 等の env var を `export` しない** (= 旧版で試みたが Function runtime に届かず不発だったため削除済 / 再追加禁止)
> - runtime env を context 別に届けたい場合は §2.3 の Netlify Dashboard context override を使うのが唯一の正解

### 1.1 ビルドコマンド

build script は **CI と Netlify で分離**:

| 環境 | エントリ | 中身 |
|------|----------|------|
| CI (GitHub Actions) | `pnpm build` | `prisma generate && next build` |
| Netlify | `bash scripts/netlify-build.sh` → `pnpm build:netlify` | `prisma generate && prisma migrate deploy && next build` |

**PR-V8.1 (2026-05-19) 改訂**: マイグレーションは Netlify build 時に **自動適用** (= `pnpm build:netlify`)。
旧設計は「手動実行で慎重に」だったが、PR-V7a で migration 適用漏れにより `billing-overdue-alert` が 500 (`payment_due_date` カラム不在で SQL error) になる事故が発生。

**なぜ build を 2 つに分けるか**:
- CI の `Lint/Test/Build` workflow では `DATABASE_URL=localhost:5432/dummy` を渡している (= 実 DB 不要で次の build artifact だけ作る)
- `prisma migrate deploy` は実 DB に接続するため、ダミー URL では `P1001: Can't reach database server` で失敗する
- → CI では `pnpm build` (migrate なし)、Netlify では `pnpm build:netlify` (migrate あり) と分離する

**運用ルール**:
- ADD COLUMN / CREATE INDEX 等の **非破壊変更** は自動適用で問題なし (旧コード互換)
- DROP / RENAME / NOT NULL 追加等の **破壊変更** は依然 §4.2 の「2 段 deploy」を踏むこと (= 先に新旧互換コードを merge → 本番 DB を手動で migration → 旧コード削除を merge)
- `prisma migrate deploy` は idempotent (= 適用済みは skip) なので二重実行は無害

### 1.2 ビルド credits 節約 (`scripts/netlify-ignore.sh`)

> **重要 (2026 年モデル変更)**: Netlify は無料枠を「ビルド分」から「**統合 credits モデル**」に変更済 (Free plan = **300 credits/月**)。
> 1 回の Production deploy がおおよそ **15 credits 消費** (本サービス実測 90 credits / 6 deploys = 15)。Web requests / Compute / Bandwidth / AI inference も微小ながら credits を消費する。**`no overage charges ever` の文言通り、300 を超えると新規 deploy / リクエスト処理が停止する** (課金されない代わりにサービスが止まる)。
> 詳細は Netlify Admin → Usage & billing タブで実況可。

300 credits/月 を効率消費するため、以下の変更だけならビルドを skip:

- `docs/**`
- `.github/**`
- `.vscode/**`
- ルートの `*.md`
- `.gitignore` / `LICENSE` / `CODEOWNERS`

詳細は [`scripts/netlify-ignore.sh`](../../scripts/netlify-ignore.sh) のコメント参照。

---

## 2. 環境変数

Netlify ダッシュボード → Site configuration → Environment variables、または `netlify env:set` CLI で登録。
全リストは [`docs/operations/ENV_VARS.md`](./ENV_VARS.md) を参照。

### 2.0 ★必須★ DB 接続 URL は 2 つ設定する (Supabase 制約)

PR #412 マージ後の deploy で `prisma migrate deploy` が `P1001: Can't reach database server at db.*.supabase.co:5432` で失敗する事象が発生。Supabase の **Direct connection (`db.[ref].supabase.co:5432`) は IPv6 のみ提供** で、Netlify build runner (IPv4 経由) から到達不能なため。詳細: [KDD §5.X+82](../knowledge/KDD_PATTERNS.md)

以下の 2 つを **両方** 設定すること:

| 環境変数 | 用途 | Supabase 連携元 | URL 形式 |
|---|---|---|---|
| `DATABASE_URL` | Application runtime (Netlify Functions の Prisma Client) | Database → Connection string → **Transaction (port 6543)** | `postgresql://postgres.[ref]:[PW]@aws-0-[region].pooler.supabase.com:6543/postgres` |
| `DIRECT_URL` | `prisma migrate deploy` (build 時) | Database → Connection string → **Session (port 5432)** | `postgresql://postgres.[ref]:[PW]@aws-0-[region].pooler.supabase.com:5432/postgres` |

両方とも `--secret` 扱いで Netlify env に登録する。`prisma.config.ts` が `DIRECT_URL || DATABASE_URL` の優先順で接続先を決定するため、`DIRECT_URL` が未設定だと `DATABASE_URL` を fallback で使用 → Transaction pooler は prepared statement 非対応で migrate が壊れる、または上記 Direct connection で IPv6 制約に当たる。

```bash
# Transaction pooler (= ランタイム用、prepared statement 自動回避)
netlify env:set DATABASE_URL "postgresql://postgres.xxxxx:****@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres" --secret \
  --context production --context deploy-preview --context branch-deploy

# Session pooler (= migrate 用、prepared statement OK + IPv4 対応)
netlify env:set DIRECT_URL "postgresql://postgres.xxxxx:****@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres" --secret \
  --context production --context deploy-preview --context branch-deploy
```

> **既存設定の確認方法**: Netlify Dashboard → Site configuration → Environment variables で `DATABASE_URL` の値を表示。`db.[ref].supabase.co:5432` (Direct connection) を指している場合は **必ず Pooler URL に変更** すること。

### 2.1 Secret マーキング

機密値 (DB パスワード / API キー / NEXTAUTH_SECRET / CRON_SECRET 等) は **Secret 扱い**で登録する:

```bash
netlify env:set KEY_NAME "value" --secret \
  --context production --context deploy-preview --context branch-deploy
```

> Netlify CLI v26 以降、`--secret` 利用時は **非 dev context を明示指定必須**。

### 2.2 一括登録 (移行・引き継ぎ時)

リポジトリ外に `.env.netlify-prod` を作成し、`netlify env:import` で一括投入する手順は [`docs/operations/ENV_VARS.md §3`](./ENV_VARS.md) を参照。

### 2.3 ★必須★ Deploy context ごとに値を分ける env var (context override)

Netlify は **同一 env var を deploy context (Production / Deploy preview / Branch deploys / Local development) ごとに別値で持てる**。
全 context 共通だと壊れる代表例:

| 変数名 | Production | Deploy preview | Branch deploys | 理由 |
|---|---|---|---|---|
| `NEXTAUTH_URL` | `https://tasukiba.com` | **未設定 (Delete)** | **未設定 (Delete)** | preview/branch は URL が動的に変わるため、本番 URL を共有設定すると NextAuth が本番 origin にリダイレクトしてしまう (= KDD §5.X+101 で実害)。未設定にすれば `trustHost: true` で host header から動的取得 |
| `STRIPE_ENABLED` | `true` (リリース後) | `true` (TC 実行用) | `false` または `true` (検証目的に応じ) | プレビューでも Stripe 動作を検証する必要があれば `true` を上書き設定 |
| `STRIPE_SECRET_KEY` | `sk_live_xxx` (Live key) | `sk_test_xxx` (Test mode) | `sk_test_xxx` (Test mode) | 本番のみ Live mode、preview/branch は必ず Test mode key を使用 (誤って本番カードに課金しないため) |
| `STRIPE_WEBHOOK_SECRET` | Live mode endpoint の `whsec_xxx` | Test mode endpoint の `whsec_xxx` | Test mode endpoint の `whsec_xxx` | Stripe Dashboard 上でも Test / Live で別エンドポイントを作成すること |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_live_xxx` | `pk_test_xxx` | `pk_test_xxx` | SECRET_KEY とペアで切替 |

#### Netlify Dashboard での context override 操作手順

1. **Site configuration → Environment variables** を開く
2. 対象 env (例: `NEXTAUTH_URL`) の **Edit** をクリック
3. **"Different value for each deploy context"** をチェック
4. 各 context (Production / Deploy previews / Branch deploys / Local development) ごとに値を入力
   - **空欄にすると "undefined" として伝わる** (= NextAuth の `trustHost: true` フォールバックを発火させる用途等で重要)
5. Save をクリック → 即時反映 (= 次回 build 以降に有効)
6. 反映確認のため対象 PR の Deploy Preview を **Trigger deploy** (or Clear cache and deploy)

> ⚠️ **build wrapper (`scripts/netlify-build.sh`) 内の `export NEXTAUTH_URL=...` は実質効果なし** (= Next.js は `NEXT_PUBLIC_*` 以外を build 時に bundle に焼き込まないため、Function runtime に伝わらない)。KDD §5.X+101 で実証済み・再追加禁止コメントあり。runtime に env を context 別に届けたければ **Netlify Dashboard の context override が唯一の正解**。

#### CLI 経由で context override する方法

特定 context にだけ値を入れる:
```bash
# Production context のみ NEXTAUTH_URL を固定
netlify env:set NEXTAUTH_URL "https://tasukiba.com" --context production

# Deploy Preview / Branch deploy では削除 (= undefined にして trustHost を活かす)
netlify env:unset NEXTAUTH_URL --context deploy-preview
netlify env:unset NEXTAUTH_URL --context branch-deploy
```

全 context まとめて確認:
```bash
netlify env:list --context production
netlify env:list --context deploy-preview
netlify env:list --context branch-deploy
```

> **関連**: PR #425 / KDD §5.X+101 (NEXTAUTH_URL context 分離) / KDD §5.X+99 (Stripe Deploy Preview redirect)

### 2.4 Stripe feature flag (`STRIPE_ENABLED`) の運用切替

`STRIPE_ENABLED` は文字列 `'true'` の場合にのみ Stripe 機能 (UI 表示 / API 受付 / Webhook 処理) が有効化される **feature flag**。Stripe 関連の全 service / route / cron 冒頭で `isStripeEnabled()` (`src/lib/stripe.ts`) を経由してチェックする。

| 値 | 挙動 |
|---|---|
| `'true'` | Stripe 機能 ON (Checkout / Webhook / Metered billing / 自動 suspend / reconcile すべて稼働) |
| 未設定 / `'false'` / その他 | Stripe 機能 OFF (UI から関連セクションが消える + Webhook は 503 / cron は no-op 早期 return) |

**TC 実行手順との連携**:

1. 新規 Deploy Preview を立てる前に Netlify Dashboard で **Deploy preview context の `STRIPE_ENABLED=true`** を確認
2. 同時に **`STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRICE_*` も Test mode 値** がセットされていることを確認
3. PR 作成 / push → Deploy Preview build → Stripe UAT 実施
4. 本番リリース時は Production context で `STRIPE_ENABLED=true` + Live mode key 一式に切替

> ⚠️ **本番切替前のチェックリスト**: Stripe Dashboard 側で Live mode の Product / Price / Webhook endpoint がすべて作成済かを確認。詳細は [`STRIPE_SETUP.md`](./STRIPE_SETUP.md) と [`docs/business/STRIPE_BILLING.md`](../business/STRIPE_BILLING.md)。

> **関連**: PR #425 / KDD §5.X+99, §5.X+100, §5.X+103

### 2.5 Cookie `sameSite` 設定の注意 (Stripe Checkout 戻り対応)

`src/lib/auth.config.ts` の session cookie `sameSite` は **`'lax'` を維持** (PR #425 で `'strict'` → `'lax'` に再緩和)。
理由: Stripe Checkout の `success_url` 経由で外部 origin (`checkout.stripe.com`) から自 origin に top-level GET redirect される際、`'strict'` だと session cookie が送信されず、コールバック handler が未認証扱いで `/login` に飛ばされてしまうため (= 「カード登録したのに失敗扱い」+ `paymentMethod='credit_card' / sub_id=null` の請求漏れ状態)。

env var 直接設定ではなく **コード内定数** だが、運用者が「セキュリティ強化」と称して `'strict'` に戻すと請求 invariant が壊れるため、**変更禁止コメント** を必ず確認。

> **関連**: PR #425 / KDD §5.X+103 / `feedback_billing_invariant`

---

## 3. 開発フロー (ローカル → ステージング → 本番)

**前提**: Netlify サイトは GitHub リポジトリと接続済み (Admin URL: <https://app.netlify.com/projects/tasukiba>)。

### 3.1 3 種類の build context

Netlify は GitHub への push を検知して、状況に応じて 3 種類の build を生成する:

| Context | トリガー | URL | 主用途 |
|---|---|---|---|
| **Production build** | `main` への push (= PR merge) | `https://tasukiba.com` | 本番リリース (外部ユーザ向け) |
| **Branch Deploy** | 指定ブランチ (例: `staging`) への push | `https://<branch-name>--tasukiba.netlify.app` | **ブランチ単位の途中経過確認**、他者共有可 |
| **Deploy Preview** | PR の作成 / 更新 | `https://deploy-preview-<PR番号>--tasukiba.netlify.app` | **PR マージ判断のステージング検証**、レビュアー共有 |

**ポイント**:
- 3 種類とも **同じ credits 枠 (Free plan = 300/月)** から消費される。「本番用 credits」「ステージング用 credits」のように分離はされない
- Production build 以外は **`main` に反映されない** ため、Branch Deploy / Deploy Preview でいくら検証しても外部ユーザには影響しない
- Stripe Webhook 等の固定 URL を要求する機能は Branch Deploy 推奨 (= URL が固定される)、PR 単位の個別検証は Deploy Preview 推奨

### 3.2 標準フロー (= スキーマ変更を含まない通常開発)

```bash
# 1. 機能ブランチで作業 (ローカル検証)
git checkout -b feat/xxx
# ... 編集 ...
pnpm lint && pnpm test     # ローカルで型・lint・単体テスト確認
git add .
git commit -m "feat: xxx"
git push -u origin feat/xxx

# 2. GitHub で Pull Request を作成 (→ Deploy Preview build 自動発火 = ~15 credits)
#    → URL: https://deploy-preview-NNN--tasukiba.netlify.app
#    → このプレビュー URL で「ステージング動作確認」を実施 (= マージ判断)
#    → docs だけの変更なら scripts/netlify-ignore.sh で skip される (= credits 0)

# 3. レビュー + 動作確認 OK → main にマージ (→ Production build 自動発火 = ~15 credits)
#    → URL: https://tasukiba.com
#    → Locked Deploy 設定 (§5) が有効なら手動 Publish が必要

# 4. 本番動作確認 (smoke test)
```

### 3.3 Branch Deploy を使う場面

Branch Deploy は **PR を作成せずに動作確認したい** ケースで使う:

- **同じ URL で繰り返し検証したい** (Stripe Webhook 等の固定 URL 要求機能)
- **PR を作る前に他者にレビュー依頼したい** (= まだ wip / draft 段階)
- **複数 PR を統合した状態で UAT したい** (= 機能横断の挙動検証)

#### Branch Deploy の有効化

1. Netlify Admin → **Site configuration → Build & deploy → Branches and deploy contexts**
2. **Branch deploys** セクションで `Add additional branches` をクリック
3. 対象ブランチ名 (例: `staging`) を入力

#### Branch Deploy の発火

```bash
# 対象ブランチに push するだけで build が走る
git push origin staging   # → ~15 credits 消費、URL: staging--tasukiba.netlify.app
```

> **注意**: Branch Deploy したブランチで env vars を別途設定したい場合は、Netlify Admin → Environment variables の各変数の `Edit` で **「Branch deploys」context** を選び、対象ブランチ専用の値を登録する (= 本番 context とは別の値を与えられる)。

### 3.4 Deploy Preview の挙動詳細

PR を作成すると **自動的に** Deploy Preview が build される。これがユーザの言う「ステージング環境」に最も近い:

```
[PR 作成 / push] → Deploy Preview build (~15 credits)
                  → URL: deploy-preview-NNN--tasukiba.netlify.app
                  ↓
                  動作確認 (= ステージング検証)
                  ↓
                  OK なら main merge → Production build
                  ↓
                  Deploy Preview URL は PR close で無効化
```

**PR ごとに URL が変わる**ため Stripe Webhook 等の固定 URL 要求機能とは相性が悪い。その場合は §3.3 の Branch Deploy を併用する。

#### 同一 PR ブランチへの追加 push の挙動

ご認識のとおり、PR 作成後に同じブランチへ追加 push すると **Netlify が自動で Deploy Preview を rebuild** する。手動操作は一切不要。

```
[10:00] PR 作成 / push   → Deploy Preview build #1 (~15 credits)
                          URL: deploy-preview-NNN--tasukiba.netlify.app

[10:30] レビュー修正 push → Deploy Preview build #2 (~15 credits)
                          URL: 同じ (build artifact のみ更新)
                          env vars も Deploy Preview context が継続使用される (= 上書き再設定不要)

[11:00] さらに修正 push  → build #3 (~15 credits)
                          URL: 同じ
```

| 項目 | 挙動 |
|---|---|
| 手動操作 | ❌ 不要 (git push するだけ) |
| URL | ✅ 同じ URL を維持 (`deploy-preview-NNN--tasukiba.netlify.app`) — ブックマークも有効 |
| env vars | ✅ Deploy Preview context が自動継承 (= §3.4「§5.X+XX env vars 設定は初回のみ」原則) |
| build credits | ⚠️ **push 回数 × ~15 credits 消費** (= 浪費注意 → §3.5 参照) |

### 3.5 同一 PR 内の追加 push を抑制する手段 (= credits 浪費防止)

push 1 回 = 1 build = ~15 credits 消費。試行錯誤の細かい push は credits 浪費の最大要因。以下 4 段階の抑制策を組み合わせる。

#### 抑制策 1: そもそも push しない (= 0 credits)

push 前にローカルで全部検証する。**最も効果が高い**。

```powershell
# 1 回の push で 1 回の build に集約する
pnpm lint
pnpm test
pnpm tsc --noEmit
# ↑ 全部 pass してから push
git push
```

#### 抑制策 2: 連続 push の auto-cancel (= Netlify 自動機構)

同一ブランチへ短時間に複数 push すると、Netlify は **進行中の build を自動 cancel** して最新 push の build だけを完走させる。**設定不要**、デフォルト挙動。

```
[10:00:00] push A → build A 開始 (build minutes 計測中)
[10:00:30] push B → ★ build A を auto-cancel ★ → build B 開始
[10:00:45] push C → ★ build B を auto-cancel ★ → build C 開始
[10:05:30] build C 完走 (~15 credits)

結果: 3 回 push したが消費は build C 分のみ (= ~15 credits, 45 ではない)
```

ただし **「最初の build が完走してから次の push」** だと両方完走するので注意:

```
[10:00] push A → build A (5 分)
[10:06] push B → build B (5 分) ← build A はもう完走しているので cancel されない
→ 消費: ~30 credits
```

#### 抑制策 3: PR タイトル / コミットメッセージで明示的に skip (★配置場所が deploy 種別で異なる★)

特定の build を明示的にスキップする 2 つのフラグ:

| フラグ | 効果 | 推奨用途 |
|---|---|---|
| **`[skip ci]`** | **CI (GitHub Actions) + Netlify build の両方を skip** | 「動作確認も lint/test も不要」が確信できる変更 (= 例: typo 修正、コメントのみ変更) |
| **`[skip netlify]`** | **Netlify build のみ skip** (CI は実行される) | 「lint/test は確認したいが Netlify deploy は不要」な変更 (= 例: テストコードのみ変更、CI で lint/test 結果を見たい) |

##### ★最重要★ 配置場所は deploy 種別で異なる

Netlify 公式仕様 ([Manage deploys → Skip a deploy](https://docs.netlify.com/site-deploys/manage-deploys/)) により、フラグの **有効な配置場所が deploy 種別で異なる**。**間違えるとフラグは無視され、Deploy Preview が走ってしまう** (= PR #425 で複数回踏んだ実例 / [KDD §5.X+114](../knowledge/KDD_PATTERNS.md)):

| Deploy 種別 | フラグを書く場所 |
|---|---|
| **Deploy Preview (= PR / MR)** ← **本サービスの「ステージング環境」はこれ** | **PR / MR のタイトル**。commit message に書いても **無視される** |
| **Branch deploy / Production deploy** (= push 直行で発生する deploy) | **commit message のどこか** (= 件名でも本文でも可) |
| 複数 commit の push | **最新 commit** の message に入れれば push 全体に適用 |

> **なぜ PR では commit message が無視されるか**: Netlify は GitHub Webhook 経由で deploy をトリガする際、PR コンテキストでは「PR タイトル」を skip 判定の入力にする (= 個々の commit message ではなく PR メタデータを参照)。push 直行ブランチでは PR が存在しないため commit message を参照する。

##### 使用例 (= 本サービスの実運用パターン)

```bash
# 例 A: PR の Deploy Preview を skip したい (= ステージングデプロイを抑制したい場合の標準手段)
#       → PR タイトルに [skip netlify] を入れる
gh pr edit 123 --title "docs: README typo 修正 [skip netlify]"
# 既存 PR タイトルの末尾に追記すれば OK。次の push から Deploy Preview が skip される。

# 例 B: PR 作成時から skip したい場合
gh pr create --title "docs: README typo 修正 [skip netlify]" --body "..."

# 例 C: 保険として PR タイトル + commit message 両方に入れる (= PR がマージされた後の main commit も skip 候補にしたい場合)
gh pr edit 123 --title "docs: README typo 修正 [skip netlify]"
git commit -m "docs: README typo 修正 [skip netlify]"

# 例 D: 「Netlify も CI も両方 skip」したい (= レビューも不要な軽微修正)
gh pr edit 123 --title "docs: README typo 修正 [skip ci]"
```

⚠️ **`[skip ci]` の注意点**: GitHub Actions の lint/test/build も skip されるため、レビュアーが PR で「lint pass / test pass」を確認できなくなる。レビューが必要な変更には付けないこと。

⚠️ **過去の罠 (PR #425, 2026-05-21)**: 「commit message に `[skip netlify]` を入れたのに Deploy Preview がデプロイされた」事象が複数 commit で発生。原因は本セクションの「PR では commit message ではなく PR タイトル」要件を見落としたまま運用していたため。詳細: [KDD §5.X+114](../knowledge/KDD_PATTERNS.md)

⚠️⚠️ **★最重大★ 過去の罠 (PR #425 / #426 → 本番未反映 / 2026-05-22 発覚, PR #428)**: ローカル commit message に `[skip netlify]` を書くと、**GitHub の squash merge で main の commit message にそのまま持ち越され、Netlify Production deploy も skip される**。PR #425 / #426 で 3 連続 skip が発生し、**sticky header / signup 3 層判定 (severity-1) が約 1 日本番未反映** という事業継続性リスクを誘発。詳細: [KDD §5.X+114](../knowledge/KDD_PATTERNS.md)

##### ★必読★ 運用ルール (再発防止)

1. **ローカル commit message には `[skip netlify]` / `[skip ci]` を絶対に書かない** — 書くなら **PR タイトルだけ**
2. **reviewer / maintainer は squash merge UI で commit subject / body から `[skip *]` を削除する** — GitHub の「Confirm squash and merge」画面で title 入力欄と body 入力欄の両方から手作業で取り除く (= 元の PR description / 各 commit message から自動連結されるため、明示削除しないと残る)
3. **マージ後の確認**: Netlify Dashboard → Deploys タブで該当 commit の Production deploy が `Building` / `Ready` になっていることを確認。`Skipped` になっていたら本罠を踏んでいる。**即時 "Trigger deploy → Deploy site" で復旧** (= 過去分の変更がまとめて反映される)
4. **回帰検証**: 本ファイル §3.5 末尾の「reviewer チェックリスト」を squash merge 前に必ず実施 — [CONTRIBUTING.md §4.4](../../CONTRIBUTING.md) も参照

##### reviewer チェックリスト (squash merge 直前に必ず確認)

- [ ] commit subject に `[skip ci]` / `[ci skip]` / `[no ci]` / `[skip actions]` / `[actions skip]` / `[skip netlify]` が **意図的に** 含まれていないこと (Production deploy / CI を **走らせたい** PR では削除)
- [ ] commit body 内に上記キーワードの **生文字列** が残っていないこと (= doc 引用や PR description の自動連結で残りがち)
- [ ] PR タイトルに `[skip netlify]` がある場合、それが「Deploy Preview を skip する意図」であることを確認 (= 本番に流したい PR では PR タイトルからも削除)
- [ ] マージ後 1-2 分以内に Netlify Dashboard で Production deploy が `Skipped` ではなく `Building` / `Ready` になっていることを確認

#### 抑制策 4: 既存の `scripts/netlify-ignore.sh` (= path ベース skip)

本プロジェクトに導入済の Netlify Ignore Build 設定で、以下の path だけの変更なら **自動で build skip** (= フラグ不要):

- `docs/**`
- `.github/**`
- `.vscode/**`
- ルートの `*.md`
- `.gitignore` / `LICENSE` / `CODEOWNERS`

詳細は §1.2 参照。

#### 抑制策 5: 手動 cancel (= 不要 push に気付いた直後)

push 後 / build 進行中に「不要だった」と気付いた場合、Netlify Dashboard から手動キャンセル可能:

1. https://app.netlify.com/projects/tasukiba → **Deploys** タブ
2. 進行中の build (status: `Building` or `Initializing`) を選択
3. 右上の **「Cancel deploy」** ボタン → 確認

⚠️ **すでに消費した credits は戻らない** (= 早く気付くほど節約効果が高い):

| cancel タイミング | 消費目安 |
|---|---|
| 0-30 秒 | ~1 credit |
| 1-2 分 | ~5 credits |
| 4-5 分 | ~15 credits (= 完走と同じ) |

→ **不要 push に気付いたら即 cancel** が原則。

### 3.6 Credit 浪費防止 Tips (全体まとめ)

Netlify Personal plan は **1,000 credits/月** (= Production deploy 約 65 回相当、ADR-0023 で Starter から昇格)。リリース直後のフェーズでは消費が増えやすいので、以下を徹底する。

| Tip | 効果 | 適用方法 |
|---|---|---|
| **ローカルで lint / test / 型チェックしてから push** | 失敗 build を削減 | `pnpm lint && pnpm test && pnpm tsc --noEmit` |
| **docs だけの変更は scripts/netlify-ignore.sh で自動 skip** | docs PR = 0 credits | 自動 (`docs/**`, `*.md`, `.github/**` 等は build skip) |
| **連続 push の auto-cancel に任せる** | 同一ブランチに新 push が来ると進行中 build を自動 cancel | Netlify 標準機能、設定不要 |
| **WIP PR は draft 状態にする** | Draft PR は Deploy Preview を build しない設定可 | Netlify Admin → Build & deploy → Skip drafts |
| **PR タイトルに `[skip netlify]`** ★Deploy Preview (= ステージング) を明示 skip する標準手段★ | **PR の Deploy Preview のみ** skip、CI は実行 (Netlify deploy 不要時) | `gh pr edit <N> --title "...[skip netlify]"` (commit message ではなく **PR タイトル** に書く点に注意 — §3.5 参照) |
| **PR タイトルに `[skip ci]`** | PR の Deploy Preview + GitHub Actions の **両方** skip (動作確認・lint/test も不要時) | `gh pr edit <N> --title "...[skip ci]"` |
| **commit message に `[skip netlify]` / `[skip ci]`** | **push 直行 deploy** (branch deploy / Production deploy) のみ有効。PR Deploy Preview では無視される | コミット時に手動。⚠️ **squash merge で main commit に持ち越されて本番 deploy も skip される罠あり** ([KDD §5.X+114](../knowledge/KDD_PATTERNS.md)) — 原則として **ローカル commit message には書かない** |
| ★最重要運用ルール★ **squash merge UI で `[skip *]` を必ず削除** | reviewer / maintainer | GitHub の「Confirm squash and merge」画面で commit subject / body の両方から手作業で削除する (= 元の PR description / 各 commit message からの自動連結を断ち切る) |
| **不要 push に気付いたら即 cancel** | Netlify Dashboard → Deploys → Cancel deploy (早いほど消費少) | 手動 |
| **複数の修正をまとめて 1 PR に bundle** | PR 数 = build 回数を削減 | 検証が独立に行える限り bundle (= [feedback_bundle_under_credit_pressure.md](../../CLAUDE.md) 参照) |
| **ローカル `pnpm dev` で済む検証は push しない** | 軽微な UI 修正は localhost で確認 | Netlify への push を最小化 |
| **残 100 credits で Pro plan ($19/月) 移行を即時判断** | 300 超過すると deploy 停止 (翌月 16 日まで復旧不可) | Netlify Admin → Usage & billing で実況可 |

> **判断基準**: 「本番事故 → hotfix を 3 回連発」= 3 × 15 = **45 credits 一気消費** + 信頼失墜。Deploy Preview で事前検証していれば 15 credits + 安全。**事前検証の credit 消費 < 事故時の hotfix 連鎖消費** という発想で判断する。

### 3.7 開発フロー サマリ (= リリース後の標準運用)

```
[ローカル]
  ├ pnpm lint && pnpm test && pnpm tsc --noEmit  (credits 0)
  └ ローカルの単体検証で OK なら push

[Deploy Preview (= ステージング検証)]
  ├ PR 作成 → 自動 build (~15 credits)
  └ deploy-preview-NNN--tasukiba.netlify.app で人間が UAT
  
[Production deploy (= main merge)]
  ├ レビュー + UAT 通過 → main merge → 自動 build (~15 credits)
  └ tasukiba.com に反映、外部ユーザ公開

合計: ~30 credits / 1 機能 (修正なし時) / Free plan 月 10 機能ペース
```

---

## 4. スキーマ変更を含むデプロイ

手順の **順序が重要**: **マイグレーション適用を先、デプロイを後** にしないと、新コードが旧スキーマで起動して `column X does not exist` エラーになる。

### 4.1 推奨手順

```bash
# 1. 機能ブランチで開発 + ローカルマイグレーション作成
git checkout -b feat/xxx
# prisma/schema.prisma を編集
npx prisma migrate dev --name xxx
# ... アプリコード修正 ...
git add .
git commit -m "feat: スキーマ変更 + xxx"
git push -u origin feat/xxx

# 2. PR 作成 → レビュー
```

**マージ手順** (順序厳守):

1. **本番 DB にマイグレーションを先に適用**
   - Supabase ダッシュボード → SQL Editor → `migration.sql` 全文貼付 → Run
   - "Success" を確認
2. **追加カラムに `DEFAULT` がある場合**、旧コードも既存のまま動く (ADD COLUMN は互換性あり)
3. 本番 DB 更新後、**GitHub で PR をマージ** → Netlify が自動デプロイ
4. Locked Deploy が有効なら、Netlify UI で対象 deploy を選んで **「Publish deploy」**
5. デプロイ完了後、<https://tasukiba.com> にアクセスし動作確認

### 4.2 破壊的変更 (DROP / RENAME) の場合

旧コードと新コードがしばらく併存することを考慮し、**2 段デプロイ** を検討:
- PR (a): 新旧両対応のコードをマージ + マイグレーションは後回し
- Supabase で手動マイグレーション適用
- PR (b): 旧列への参照を削除

### 4.3 backfill UPDATE を含む migration の運用 (ADR-0016 Revised / 2026-05-22 で確立)

新規 column 追加 + 既存行への backfill UPDATE を伴う migration では、**「自動推定で値が決まらない行」が NULL 残置するシナリオ**が常に存在する。例: `20260527_tenants_created_by_user_id_tracking` (PR #426) では「admin/super_admin user が居ない tenant」が NULL 残置候補。

**推奨パターン**: migration の最後に **`RAISE WARNING`** で残置件数を出力し、運用者が deploy ログから検知できるようにする:

```sql
DO $$
DECLARE
  null_count INT;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM "<table>" WHERE "<new_column>" IS NULL AND "deleted_at" IS NULL;
  IF null_count > 0 THEN
    RAISE WARNING
      '<migration_name>: <new_column> が NULL のまま残った行が % 件あります。'
      ' 手動で UPDATE してください。 該当行検索: SELECT id FROM <table> WHERE <new_column> IS NULL AND deleted_at IS NULL;',
      null_count;
  END IF;
END $$;
```

**deploy 後の確認手順**:

1. **Netlify build ログ確認**: `prisma migrate deploy` 出力に `WARNING` が含まれていないか
2. **NULL 残置の SQL 確認** (= Supabase SQL Editor で実行):
   ```sql
   SELECT id, slug FROM <table>
   WHERE <new_column> IS NULL AND deleted_at IS NULL;
   ```
3. **0 件返却が期待値**。1 件以上返ったら業務的に主体を特定して手動 UPDATE:
   ```sql
   UPDATE <table> SET <new_column> = '<value>' WHERE id = '<id>';
   ```

**この設計の利点**:

- 自動修復不可能なケース (= 業務文脈に依存する値) を **silent fail させず必ず可視化**
- migration 自体は冪等 (= 再実行で WARNING も再出力される)
- 該当行が 0 件なら DO ブロックは何も出力しない (= 通常運用時のノイズなし)

### 4.4 ★生命線★ FAQ / Guide 編集を含む deploy の手順 (ADR-0028 RAG)

> **本節を読まずに deploy すると、新規 FAQ がフクロウに認識されません**。FAQ/使い方ガイドの追加・更新・削除を含む PR をマージしたら **必ず** 本手順を実行してください。詳細は [FAQ_AND_OWL_CHAT_GUIDE.md §7](../developer-guide/FAQ_AND_OWL_CHAT_GUIDE.md) を参照。

#### 4.4.1 PR レビュー時の確認 (reviewer 向け)

- [ ] PR に `src/config/faq-content.ts` または `src/config/guide-content.ts` の変更が含まれるか確認
- [ ] 含まれる場合、PR 説明に「★FAQ/Guide 編集を含む。deploy 後に `pnpm generate:faq-embeddings` を実行★」が記載されているか確認
- [ ] 記載がなければマージ前に PR author に指摘
- [ ] CI で `check:faq-embeddings-sync` (structure mode) が PASS していることを確認

#### 4.4.2 deploy 直後の generate スクリプト実行 (deploy 担当者向け)

```bash
# 1. ローカルに本番 DB 接続情報と Voyage API キーを設定 (.env.local)
DATABASE_URL='postgresql://...本番接続...'
DATABASE_URL_DIRECT='postgresql://...本番直接接続...'
VOYAGE_API_KEY='pa-xxx...'

# 2. dry-run で実行計画を確認 (Voyage API 呼出ゼロ、安全)
pnpm generate:faq-embeddings --dry-run

# 出力例:
#    📚 faq_embeddings 同期 (46 件 in config)
#       ➕ csv-import-external-wizard-4steps-detail (add)
#       🔄 billing-cycle (update)
#       🗑  obsolete-entry-id (delete = config から削除済)
#    📊 faq_embeddings: +1 追加 / ~1 更新 / =44 不変 / -1 削除 / ❌0 失敗 (total 47)

# 3. 想定どおりであることを確認したら実 generate を実行
pnpm generate:faq-embeddings

# 4. (任意) drift ゼロを確認
pnpm check:faq-embeddings-sync
# → "DB embedding は config と完全同期しています" が出れば OK
```

#### 4.4.3 失敗時の対処

| 症状 | 原因 | 対処 |
|---|---|---|
| `VOYAGE_API_KEY` 未設定エラー | `.env.local` に未設定 | Voyage AI ダッシュボードから API キー取得して設定 |
| `DATABASE_URL` 未設定エラー | `.env.local` に未設定 | 本番接続文字列を設定 (DATABASE_URL_DIRECT も推奨) |
| Voyage API rate limit エラー | 大量再生成時 | 数分待って再実行 (本 script は冪等で残った行のみ処理) |
| 一部 entry が `❌ 失敗` | Voyage 一時障害 | 再実行で残り分のみ処理 |
| `pnpm check:faq-embeddings-sync` が drift エラー | generate 未実行 / 部分失敗 | `pnpm generate:faq-embeddings` を再実行 |

#### 4.4.4 本 SOP の存在意義 (★生命線★)

- 本 SOP を実行しないと: 新 FAQ がフクロウに認識されない → 「該当する FAQ がありません」と回答 → 初心者ユーザの離脱率増加 → サービス満足度低下
- これは **コードレビュー / CI では検知できない** (config 側だけ見れば正しいため)
- 4 層防御パターンの **手動 SOP 層** (KDD §5.X+193 参照)
- 自動化案 (deploy hook で自動実行) は将来検討中だが、現状は手動で確実性を優先

---

## 5. Locked Deploy (本番事故防止)

`main` ブランチへのマージで自動デプロイが走るが、**「Publish」 (本番反映) は手動承認制**にすることを推奨。

### 5.1 設定手順 (一度だけ実施)

1. Netlify Admin → **Site configuration → Build & deploy → Continuous deployment**
2. **Production branch** = `main` を確認
3. **Deploys → 最新の Ready deploy を選択 → 「Lock publish」**
4. 以後、main マージで build は走るが publish は手動 click が必要

### 5.2 Publish 操作

1. Netlify Admin → Deploys タブ
2. 公開したい deploy (typically 最新の Ready) を選択
3. **「Publish deploy」** ボタン → 確認ダイアログ → 公開

---

## 6. Cron Jobs (外部サービス)

Netlify Scheduled Functions は使わず、**[cron-job.org](https://cron-job.org)** から `/api/cron/*` ルートを HTTP POST で叩く運用とする。

### 6.1 設定対象 (9 件)

旧 `vercel.json` から移行した cron schedule + ADR-0021 で追加:

| エンドポイント | schedule (UTC) | 用途 |
|---|---|---|
| `/api/health` | `0 0 * * *` (日次 00:00) | Supabase wake (Free Plan の 1 週間アイドル停止対策) |
| `/api/admin/users/lock-inactive` | `0 3 * * *` (日次 03:00) | 30 日非アクティブユーザのロック |
| `/api/cron/daily-notifications` | `0 22 * * *` (日次 22:00) | 通知メール集約配信 |
| `/api/cron/daily-usage-aggregation` | `0 2 * * *` (日次 02:00) | 日次利用量集計 |
| `/api/cron/tenant-monthly-reset` | `0 0 1 * *` (月初 00:00) | 月次テナント請求リセット |
| `/api/cron/stripe-usage-flush` | `0 5 * * *` (日次 05:00) | Stripe 利用量 flush |
| `/api/cron/stripe-auto-suspend` | `0 4 * * *` (日次 04:00) | 滞納テナント自動 suspend |
| `/api/cron/stripe-reconcile` | `0 6 1 * *` (月初 06:00) | Stripe ↔ DB 状態照合 (PR-V7 #5 / 2026-05-19) |
| **`/api/cron/attachment-embedding`** | **`*/15 * * * *` (15 分毎)** | **ADR-0021 (2026-05-26): 添付ファイル本文 embedding 背景処理 (pending → completed、指数 backoff 3 回 retry、per-tenant=5 / global=50 throttle)** |

### 6.2 cron-job.org 設定手順

1. <https://cron-job.org/en/signup/> でアカウント作成 (無料、cron 数無制限)
2. 「Create cronjob」を 8 件作成、各々以下を設定:
   - **URL**: `https://tasukiba.com/api/cron/xxx`
   - **Method**: POST (一部 GET、`/api/health` は GET)
   - **Headers**: `Authorization: Bearer $CRON_SECRET` を追加
     - `CRON_SECRET` は Netlify 環境変数と同じ値を使用
   - **Schedule**: 上記表の cron 式を入力
3. 各 cron の「Save & enable」を click
4. **各 cron で test run を実行 → 200 OK を確認** (302 / 500 を本番運用後に発見すると検知が遅れる)
5. 翌日 cron-job.org のダッシュボードで実行履歴を確認 (200 OK が確認できれば OK)

### 6.3 cron route 追加・移行時の Checklist (KDD §5.X+70)

外部 HTTP から呼ばれる cron route を追加する/Vercel Cron から移行する際は、必ず下記を確認:

- [ ] route path を [`src/config/routes.ts`](../../src/config/routes.ts) の `PUBLIC_PATHS` に登録
      (未登録だと middleware の auth check で `/login` へ 302 redirect される)
- [ ] route ハンドラ冒頭で [`isCronAuthorized(req)`](../../src/lib/cron-auth.ts) を呼び `Authorization: Bearer <CRON_SECRET>` を定数時間比較
- [ ] env 依存の service を呼ぶ場合、その env が未設定の環境でも throw しないか確認
      (Stripe 系なら `if (!isStripeEnabled()) return early;` を冒頭に置く)
- [ ] cron route 本体を [`withCronExecutionLogging(name, req, async () => {...})`](../../src/lib/cron-execution-log.ts) でラップ (= super_admin ダッシュボード上で実行履歴と timeout 検知が可能になる)
- [ ] [`src/config/cron-jobs.ts`](../../src/config/cron-jobs.ts) の `CRON_JOBS` に動作概要 + スケジュールを登録
- [ ] cron-job.org / 移行先 cron 管理画面で **test run → 200 OK** を確認 (本番運用前に発見できる唯一のタイミング)

過去事例: KDD §5.X+70 (Vercel→Netlify 移行で 7 件中 4 件失敗、test run で発覚) / KDD §5.X+72 (Netlify Functions 10s timeout の検知導線)

### 6.4 cron 実行履歴ダッシュボード (PR feat/cron-execution-log)

super_admin として `https://tasukiba.com/admin/super/cron-history` にアクセスすると、社内 dashboard で:

- 直近 24h の成功 / 失敗 / 実行中 / **stale running (= timeout 疑い)** の集計
- 登録 cron 一覧 (動作概要 + スケジュール)
- 直近 100 件の実行履歴 (開始時刻 / 所要 ms / status / エラーメッセージ / 呼出元 IP)

を確認できる。cron-job.org の外部ダッシュボードを補完する内部監視導線。

**stale running 検知のロジック**:
`status='running'` のまま 30 秒以上経過したレコードは Netlify Functions 10 秒上限を超過した可能性が高い (= timeout で Lambda が殺され `withCronExecutionLogging` の終了 update が走らなかった)。検出された場合は処理を chunk 化 / async 化する対応を検討。

詳細: [KDD §5.X+72](../knowledge/KDD_PATTERNS.md)

### 6.4 手動実行 (debug 用)

```powershell
$cronSecret = "<CRON_SECRET の値>"
curl -X POST `
  -H "Authorization: Bearer $cronSecret" `
  https://tasukiba.com/api/cron/daily-notifications
```

---

## 7. ロールバック

1. Netlify Admin → Deploys タブ
2. 戻したい過去の Ready deploy を選択
3. **「Publish deploy」** で即時切り戻し (前回 deploy の artifact がそのまま使われる)

DB スキーマ変更を伴うロールバックは [`ROLLBACK.md`](./ROLLBACK.md) を参照。

---

## 8. Netlify 固有の既知問題と対処

### 8.1 NextAuth `useSession().update()` の Set-Cookie が反映されない (2026-05-18 確認)

**症状**: クライアント側の `useSession().update({ X: ... })` で JWT を更新する経路で、レスポンスの `Set-Cookie` がブラウザに反映されず、JWT 内 claim が古いまま固定化される。MFA 検証 / テナント TZ-Locale 変更 / 画面テーマ変更で同時発覚。

**根本原因**: NextAuth v5 0-beta.31 + @netlify/plugin-nextjs の組合せで `POST /api/auth/session` のレスポンス cookie がプロキシ層に吸収される (一次ソース未検証、ヘッダ観察で再現確認)。旧 Vercel 環境では発生しなかった事象。

**対応 (本サービスで実施済)**:

- **PR #395**: 画面テーマは専用 cookie `tasukiba-theme` に分離。`src/app/api/settings/theme/route.ts` が DB 更新後に直接 Set-Cookie。
- **PR #396**: MFA 検証 / テナント TZ-Locale は **JWT 直接再署名**方式に切替 (`src/lib/auth-jwt-helper.ts` の `reissueAuthJwtOnResponse`)。クライアント側の `update()` 呼出しは削除。

**新規コードのルール**:

- **`useSession().update()` を新規追加しない**。同等の更新は以下のいずれかで実現:
  - **専用 cookie**: 値が SSR / middleware のみで読まれる場合 (例: テーマ)
  - **JWT 直接再署名**: middleware / useSession / SSR の複数経路で読まれる場合 (例: MFA / TZ / Locale)
- 詳細パターンは [docs/knowledge/KDD_PATTERNS.md §5.X+66](../knowledge/KDD_PATTERNS.md) を参照。
- 障害対応手順は [INCIDENT_RESPONSE.md §6.11](./INCIDENT_RESPONSE.md) を参照。

### 8.2 統合 credits 制限 (1,000 credits/月 Netlify Personal) の運用

2026 年から Netlify Plan の制限単位は「ビルド分」から「統合 credits」に変更された。Production deploy / Web requests / Compute / Bandwidth / AI inference のすべてが credits を消費する単一枠 (Free Starter = 300/月、本サービスが採用している **Personal = 1,000/月**、Pro = 1,000/月 + Background Functions)。

| 主な consumer (実測ベース、本サービス) | 単位コスト | 月間想定 (6/1 リリース直後フェーズ) |
|---|---|---|
| Production deploy | ~15 credits/回 | 10-15 回 = 150-225 credits |
| Deploy Preview (PR) | ~15 credits/回 | 5-10 回 = 75-150 credits |
| Web requests | 0.25 credits/1000 req | 数万 req = 数 credits |
| Bandwidth / Compute / AI | 微小 | 数 credits |

**1 deploy あたり ~15 credits** が支配的なので、deploy 回数を抑える運用が credits 節約に直結する:

- `scripts/netlify-ignore.sh` で docs-only PR は build を skip (= credits 0 消費)
- WIP PR は draft 状態にする、または **PR タイトル末尾に `[skip netlify]`** を付与して Deploy Preview を抑制 (= commit message ではなく **PR タイトル** に書く点が重要、詳細は §3.5)
- ローカル `pnpm dev` で済む変更は push しない

> ⚠️ ★最重要事故防止★ **本番 deploy が意図せず skip される罠** (= ローカル commit message に `[skip netlify]` を書くと squash merge で main commit に持ち越され Production deploy も skip される): PR #425 / #426 で 3 連続発生し、sticky header / signup 3 層判定 (severity-1) が約 1 日本番未反映だった事故あり。**運用ルール**: ローカル commit message には書かない / PR タイトルのみに書く / reviewer は squash merge UI で `[skip *]` を必ず削除 / マージ後は Netlify Dashboard で Production deploy が `Skipped` でないことを確認。詳細は §3.5 reviewer チェックリスト + [KDD §5.X+114](../knowledge/KDD_PATTERNS.md)。

残高は Netlify Admin → Usage & billing で実況可。**残 100 を下回ったら Pro plan ($19/月) 移行を即時判断** すること (= 300 超で deploy が止まる + 翌月 16 日まで復旧不可、リリース直前なら致命的)。

> **注**: Netlify ドキュメントには「`no overage charges ever`」と明記。これは「上限超過時に課金されない代わりにサービスが停止する」意味であり、過去の build minutes と同様の停止挙動。

---

## 9. Netlify CLI チートシート

```bash
# サイト紐付け確認
netlify status

# 環境変数の一覧 (本番 context)
netlify env:list --context production

# 環境変数の取得
netlify env:get KEY --context production

# 環境変数の追加 (機密)
netlify env:set KEY "value" --secret \
  --context production --context deploy-preview --context branch-deploy

# 環境変数の削除
netlify env:unset KEY

# ローカルから手動デプロイ (Netlify credits を節約)
netlify deploy --build              # draft URL に上がる
netlify deploy --build --prod       # 本番反映

# ビルドログの確認 (ローカルで Netlify ビルド再現)
netlify build

# 最新の deploy 一覧
netlify deploy:list
```

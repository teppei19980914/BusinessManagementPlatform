# 開発フロー手順書 — 着手 → リリース (Developer Guide)

本ドキュメントは、たすきば Knowledge Relay の **開発着手から本番リリースまでの全工程** を 1 枚で示す手順書です。
2026-06-01 以降の人間駆動開発を前提に、AI 補助なしでも全フローを再現できる粒度で記述しています。

> 既存の関連ドキュメント:
> - [TEST_LINT_BUILD.md](./TEST_LINT_BUILD.md) — テスト・lint・build の詳細手順
> - [COMMIT_AND_DEPLOY.md](./COMMIT_AND_DEPLOY.md) — コミット・PR・デプロイの詳細
> - [HOW_TO_ADD_FEATURES.md](./HOW_TO_ADD_FEATURES.md) — 機能追加の実装手順
> - [docs/operations/DEPLOYMENT.md](../operations/DEPLOYMENT.md) — Netlify 本番デプロイ手順
> - [CONTRIBUTING.md](../../CONTRIBUTING.md) — コミット規約・ブランチ規約

---

## 0. 全体フロー図

```mermaid
flowchart LR
  A[Phase 1<br/>開発着手] --> B[Phase 2<br/>ローカル開発]
  B --> C[Phase 3<br/>ローカルテスト<br/>lint/tsc/test/e2e-coverage/build]
  C --> D[Phase 4<br/>E2E テスト<br/>任意]
  D --> E[Phase 5<br/>PR 作成<br/>+ Deploy Preview 検証]
  E --> F[Phase 6<br/>コードレビュー<br/>+ main マージ]
  F --> G[Phase 7<br/>本番デプロイ<br/>Netlify 自動]
  G --> H[Phase 8<br/>本番動作確認<br/>smoke test]
```

各 Phase は前段の **完了条件 (DoD)** を満たさない限り次へ進まない原則。退行検知を遅らせると修正コストが指数関数的に増える (KDD §5.X+58 / §5.X+99 参照)。

---

## Phase 1: 開発着手

### 1.1 要件整理

- 顧客 FB or GitHub Issue を起点に、**変更スコープ・受け入れ基準・退行影響** を 1 つの Issue (or PR description ドラフト) に書き出す
- 設計判断を伴う場合は事前に [docs/adr/](../adr/) で類似 ADR を確認し、新規 ADR が必要かを判断
- 機能カタログ ([docs/business/FEATURE_CATALOG.md](../business/FEATURE_CATALOG.md)) で「触るべきファイル群」をマトリクス化

### 1.2 Issue 起票 (任意だが推奨)

- 顧客 FB 由来は [docs/operations/CUSTOMER_FEEDBACK_TRIAGE.md](../operations/CUSTOMER_FEEDBACK_TRIAGE.md) のフォーマットで P0-P3 を付ける
- 設計大改修を伴う場合は ADR ドラフト → レビュー → PR の順で進める

### 1.3 ブランチ作成

**必ず `main` の最新 HEAD から分岐** ([CONTRIBUTING.md §2.1](../../CONTRIBUTING.md) 参照)。

```bash
git checkout main
git pull --ff-only
git checkout -b feat/<short-description>
```

| 用途 | プレフィックス | 例 |
|---|---|---|
| 機能追加 | `feat/` | `feat/csv-export-projects` |
| バグ修正 | `fix/` | `fix/login-mfa-timeout` |
| ドキュメント | `docs/` | `docs/development-flow` |
| リファクタ | `refactor/` | `refactor/extract-billing-helper` |
| 緊急修正 | `hotfix/` | `hotfix/stripe-webhook-500` |

`main` / `master` / `develop` / `release/*` / `hotfix/*` への **直接コミットは禁止**。

---

## Phase 2: ローカル開発

### 2.1 環境変数 (`.env.local`) の準備

[`docs/operations/ENV_VARS.md`](../operations/ENV_VARS.md) で全変数一覧を確認。最小構成は以下。

```bash
# DB (Supabase) — 必ず 2 種類 (DATABASE_URL = pooler/6543、DIRECT_URL = session/5432)
DATABASE_URL="postgresql://postgres.xxxxx:****@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres"
DIRECT_URL="postgresql://postgres.xxxxx:****@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"

# NextAuth
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="<64 文字以上のランダム文字列>"

# Voyage embedding (提案エンジン)
VOYAGE_API_KEY="..."

# Stripe (Test mode)
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
STRIPE_ENABLED="true"
```

> **注意**: `DIRECT_URL` を未設定だと `prisma migrate dev` が Transaction pooler 経由になり prepared statement 非対応で失敗。詳細 [KDD §5.X+82](../knowledge/KDD_PATTERNS.md) / [DEPLOYMENT.md §2.0](../operations/DEPLOYMENT.md)。

### 2.2 開発サーバー起動

```bash
pnpm install              # 初回 / pnpm-lock.yaml 変更時のみ
pnpm db:seed              # 初回 / DB リセット直後 (任意)
pnpm dev                  # http://localhost:3000 で起動
```

- `pnpm dev` は Turbopack で起動 (= `next dev --turbopack`)
- ホットリロードは tsx/css/Server Component 全てに効く
- DB schema を変更したら `npx prisma migrate dev --name <change-summary>` でマイグレーション生成 + ローカル適用

### 2.3 Prisma Studio (任意)

DB の中身を GUI で確認したいときは:

```bash
npx prisma studio   # http://localhost:5555
```

### 2.4 実装時の必須チェック (毎ファイル)

- [ ] **テナント越境フィルタ**: `where: { tenantId: viewerTenantId }` が抜けていないか (severity-1)
- [ ] **ハードコード禁止**: 業務的意味を持つ値は `src/config/` 経由 ([ARCHITECTURE.md ハードコード禁止セクション](../design/ARCHITECTURE.md))
- [ ] **テスト同時追加**: 実装変更とテストを同コミットに含める ([CLAUDE.md コミットルール](../../CLAUDE.md))
- [ ] **日時 API**: `toLocaleString` 等 runtime TZ 依存 API は禁止 → `@/lib/format` のヘルパを使う ([TEST_LINT_BUILD.md §10.7](./TEST_LINT_BUILD.md))

---

## Phase 3: ローカルテスト (= コミット前 5 点セット)

[CLAUDE.md コミット前チェック](../../CLAUDE.md) で定義された **必須 5 点セット**。

```bash
pnpm lint                # 1. ESLint (静的解析)
pnpm tsc --noEmit        # 2. TypeScript 型検査
pnpm test                # 3. vitest (単体テスト + カバレッジ閾値 80%)
pnpm e2e:coverage-check  # 4. 新規 route.ts / page.tsx 漏れ検知
pnpm build               # 5. Next.js production build (型エラー含む)
```

### 3.1 各ステップの意味

| # | コマンド | 検出するもの | 失敗時の対処 |
|---|---|---|---|
| 1 | `pnpm lint` | ESLint 違反 (banned auth pattern / unused imports 等) | 出力の指示通り修正、`pnpm lint --fix` で自動修正可能なものも多い |
| 2 | `pnpm tsc --noEmit` | 型エラー (build 前に早期検出、build より速い) | エディタの inline error と一致 |
| 3 | `pnpm test` | vitest 単体テスト + カバレッジ閾値 (Lines/Statements/Functions: 80%、Branches: 70%) | [LOCAL_TEST_GUIDE.md](./LOCAL_TEST_GUIDE.md) 参照 |
| 4 | `pnpm e2e:coverage-check` | 新規 `route.ts` / `page.tsx` が `docs/test/E2E_COVERAGE.md` 未記載 | E2E_COVERAGE.md に `[x]` or `[ ] skip: <理由>` を追記 |
| 5 | `pnpm build` | Next.js のフル build (型・lint・最適化込み) | local で通れば CI/Netlify でもほぼ通る |

### 3.2 5 点セットを飛ばす罠 (典型的事故)

- **`pnpm e2e:coverage-check` を飛ばす** → CI で `Test (vitest + coverage)` が skip され `Report coverage` も連鎖 fail。**真因は manifest 漏れのみ** ([TEST_LINT_BUILD.md §9.5.1](./TEST_LINT_BUILD.md))
- **`pnpm build` を飛ばす** → Netlify build credits を消費して fail (Free plan 300 credits/月、1 deploy ≈ 15 credits)。ローカルで先に通すべき ([DEPLOYMENT.md §1.2](../operations/DEPLOYMENT.md))

---

## Phase 4: E2E テスト (任意、UI/API 変更時は推奨)

```bash
# 別ターミナルで dev サーバ起動済が前提
pnpm test:e2e                 # 全 specs + visual を実行
pnpm test:e2e:ui              # 対話モード (デバッグ用)
pnpm test:e2e:update-snapshots # 視覚回帰 baseline 更新
```

- CI でも自動実行されるため、ローカル E2E は必須ではない
- 「自分の改修範囲のみ」を高速に検証したい場合: `pnpm test:e2e e2e/specs/<spec-name>.spec.ts`
- 詳細 Tips は [E2E_TEST_GUIDE.md](./E2E_TEST_GUIDE.md) 参照
- 視覚回帰が絡む UI 変更は最初の commit に `[gen-visual]` を含める ([TEST_LINT_BUILD.md §9.6](./TEST_LINT_BUILD.md))

---

## Phase 5: PR 作成 + ステージング検証 (Netlify Deploy Preview)

### 5.1 PR 作成

```bash
git add <files>
git commit -m "$(cat <<'EOF'
件名 (PR #XXX タグ含む)

- 何を変更したか
- なぜ変更したか
- 影響範囲
EOF
)"

git push -u origin feat/...
gh pr create --title "..." --body "..."
```

PR description に **Summary / Test plan / 関連 PR・KDD** の 3 セクションを必ず含める ([CONTRIBUTING.md §4](../../CONTRIBUTING.md))。

### 5.2 Deploy Preview の自動生成

- PR push 後 1〜3 分で Netlify が **Deploy Preview URL** を生成
- URL 形式: `https://deploy-preview-NNN--tasukiba.netlify.app`
- PR コメントに Netlify Bot が URL を自動投稿
- **Deploy Preview 環境変数 = Production と分離**: `NEXTAUTH_URL` 等の context-specific 設定は Netlify Dashboard で `deploy-preview` context に登録 ([KDD §5.X+101](../knowledge/KDD_PATTERNS.md))

### 5.3 Deploy Preview での人間動作確認

- [ ] 改修対象画面で意図通りの挙動
- [ ] テナント越境テスト (別テナント user でログインして見えてはいけないデータが見えないか)
- [ ] 既存機能の退行 (関連画面の smoke test)
- [ ] ダーク/ライト両テーマで崩れていないか
- [ ] Stripe を触る場合は **Test mode のカード** (`4242 4242 4242 4242`) で完了まで通す

### 5.4 ステージング検証で詰まる典型パターン

| 症状 | 原因 / 参照 |
|---|---|
| Deploy Preview の Stripe 戻り先が本番 URL になる | `NEXTAUTH_URL` の context 分離漏れ — [KDD §5.X+99 / §5.X+101](../knowledge/KDD_PATTERNS.md) |
| Set-Cookie が脱落して signOut が効かない | Netlify Set-Cookie 罠 — [KDD §5.X+ feedback_session_clearance_pattern](../knowledge/KDD_PATTERNS.md) |
| build が成功しているのに rebuild が走らない | `scripts/netlify-ignore.sh` の path-based skip 判定 — [DEPLOYMENT.md §1.2](../operations/DEPLOYMENT.md) |
| commit message に `[skip netlify]` を入れても Deploy Preview が走ってしまう | **Deploy Preview は PR タイトルが判定対象** (commit message は無視される)。`gh pr edit <N> --title "...[skip netlify]"` で PR タイトル側に入れる — [DEPLOYMENT.md §3.5](../operations/DEPLOYMENT.md) / [KDD §5.X+114](../knowledge/KDD_PATTERNS.md) |

> **Deploy Preview (= ステージング) を明示的に skip したい場合** (= credit 浪費抑制): **PR タイトル末尾に `[skip netlify]`** を付与する。詳細は [DEPLOYMENT.md §3.5 抑制策 3](../operations/DEPLOYMENT.md)。

---

## Phase 6: コードレビュー + main マージ

### 6.1 レビュー観点

[CONTRIBUTING.md §5 コードレビューチェックリスト](../../CONTRIBUTING.md) の 10 項目を一読:

- 設計原則 (`src/config/` 経由のハードコード排除)
- テナント越境フィルタ
- テストカバレッジ
- ドキュメント更新
- 横展開漏れ (同パターンの他ファイル)
- セキュリティ ([SECURITY_CHECK_GUIDE.md](./SECURITY_CHECK_GUIDE.md))

### 6.2 ultrareview / `/security-review` skill

- 重要 PR (認可周り / Stripe / マイグレーション) では `/security-review` skill 経由で AI レビューを補助的に走らせる
- レビュアーは「最終判断者」として手動で承認する (AI レビューは参考扱い)

### 6.3 マージ方式

- **原則 squash merge** — main の commit history を 1 PR = 1 commit に保つ
- DB スキーマ変更を含む PR は、マージ前に Supabase で migration を手動実行するか、Netlify build で `prisma migrate deploy` 自動適用かを判断 ([DEPLOYMENT.md §1.1](../operations/DEPLOYMENT.md))

### 6.4 マージ後の orphan branch に注意

- マージ済 PR のブランチに **追加 push しない** (orphan commit になり main に反映されない)
- 追加修正は main から新ブランチを切り直す ([MEMORY: feedback_post_merge_branch_push](../../CLAUDE.md))

---

## Phase 7: 本番デプロイ (Netlify Production)

### 7.1 自動デプロイ

main へのマージで Netlify が **Production deploy** を自動起動:

1. `scripts/netlify-build.sh` → `pnpm build:netlify` (= `prisma generate && prisma migrate deploy && next build`)
2. `@netlify/plugin-nextjs` で Next.js 16 App Router を Functions にバンドル
3. `https://tasukiba.com/` (= 本番 URL) に反映

### 7.2 進捗確認

- Netlify Dashboard → Deploys タブ で realtime 確認
- build log → Function deploy log → DNS propagation の 3 段階を順番に確認
- 通常 3〜5 分で完了

### 7.3 ロールバック

万一 production deploy が壊れた場合:

- **Netlify Dashboard** → Deploys → 過去の green deploy を選択 → "Publish deploy" でワンクリック rollback
- DB schema 変更を含む rollback は **migration の逆適用が必要** — [docs/operations/ROLLBACK.md](../operations/ROLLBACK.md) (存在する場合) または [INCIDENT_RESPONSE.md](../operations/INCIDENT_RESPONSE.md) を参照

### 7.4 build credits の節約

- Netlify Personal plan = **1,000 credits / 月** (ADR-0023 で Starter から昇格)、1 Production deploy ≈ 15 credits
- docs-only PR は `scripts/netlify-ignore.sh` で自動 skip され credits 消費なし
- 仕様確定 docs PR と実装 PR を分けると credits 節約になる ([DEPLOYMENT.md §1.2](../operations/DEPLOYMENT.md))

---

## Phase 8: 本番動作確認

### 8.1 Smoke test (最低限)

- [ ] `https://tasukiba.com/` ログイン画面が表示される
- [ ] ログイン → `/projects` まで遷移
- [ ] 改修対象画面で意図通りの挙動
- [ ] Sentry / cron_execution_logs / API call logs に異常なエラー急増がないか
- [ ] [docs/operations/INCIDENT_RESPONSE.md](../operations/INCIDENT_RESPONSE.md) の「重大度判定基準」で severity-1 の事象がないか

### 8.2 Stripe Test mode → Live mode 切替時の注意

- Test mode で完璧に動いていても、Live mode では **webhook secret / publishable key / price ID** が別物
- 環境変数を Netlify Dashboard の `production` context にのみ live key を登録する (`deploy-preview` には test key を残す)
- 初回 Live mode 切替時は **少額の実カード決済 → 即 refund** で end-to-end 確証 ([STRIPE_SETUP.md](../operations/STRIPE_SETUP.md))

### 8.3 監視ダッシュボード

- [BILLING_MONTHLY_OPERATIONS.md](../operations/BILLING_MONTHLY_OPERATIONS.md) のチェックリスト (月次)
- [CRON.md](../operations/CRON.md) の cron 死活監視 (日次)
- API call logs / ApiCallLog SUM の真値確認 (請求 invariant の保護)

---

## 付録 A: トラブルシューティング

### A.1 Netlify rebuild が走らない

| 原因 | 対処 |
|---|---|
| `scripts/netlify-ignore.sh` の path-based skip で対象外判定 | docs-only commit に実装ファイル変更を 1 行混ぜる or 空 commit を `git commit --allow-empty -m "chore: trigger rebuild"` |
| env var 変更だけだと rebuild trigger されない | Netlify Dashboard → Deploys → "Trigger deploy" を手動押下、または空 commit |
| 同 commit SHA がキャッシュされている | "Clear cache and deploy site" を Netlify Dashboard から実行 |

### A.2 環境変数が反映されない

- Netlify は env var 変更を **次回 deploy** から反映 (既存 build は古い値を保持)
- env 変更 → 空 commit push or "Trigger deploy" で rebuild が必要
- context (production / deploy-preview / branch-deploy) を間違えていないか Dashboard で確認

### A.3 Deploy Preview が古いまま (新しい push が反映されない)

- まず Netlify Dashboard で **build が走っているか** を確認 (build credits 枯渇で skip されている可能性)
- skip されていたら手動 trigger
- 走っているのに古いまま見える場合は **ブラウザのキャッシュ** (DevTools → Network → Disable cache でリロード)

### A.4 `pnpm build` がローカルで通るのに CI で fail

- ローカルと CI で Node.js バージョンが違う (CI = Node 22) → `.nvmrc` か `volta` で揃える
- `.next/` キャッシュが原因のことがある → `rm -rf .next && pnpm build` を試す ([TEST_LINT_BUILD.md §10.6](./TEST_LINT_BUILD.md))
- `DATABASE_URL` が CI でダミー値の挙動を踏んでいる → `prisma generate` は通るが、runtime で DB 接続するコードは CI build に含めない

### A.5 マイグレーション適用漏れで 500 エラー

- 症状: Netlify deploy 直後に「カラムが存在しない」系の 500
- 原因: Supabase で migration を手動実行する設計だった頃の名残、または Netlify build で `prisma migrate deploy` が走らない設定
- 対処: [DEPLOYMENT.md §4.2 2 段 deploy 手順](../operations/DEPLOYMENT.md) を参照

---

## 関連ドキュメント

- [CLAUDE.md](../../CLAUDE.md) — Claude Code 運用ガイド (緊急時)
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — コミット規約 / ブランチ規約 / レビュー観点
- [docs/operations/DEPLOYMENT.md](../operations/DEPLOYMENT.md) — Netlify 本番デプロイ詳細
- [docs/operations/INCIDENT_RESPONSE.md](../operations/INCIDENT_RESPONSE.md) — 障害対応 SOP
- [docs/operations/ENV_VARS.md](../operations/ENV_VARS.md) — 全環境変数一覧
- [docs/knowledge/KDD_PATTERNS.md](../knowledge/KDD_PATTERNS.md) — 過去の罠と教訓
- [LOCAL_TEST_GUIDE.md](./LOCAL_TEST_GUIDE.md) — ローカルテストの書き方 Tips
- [E2E_TEST_GUIDE.md](./E2E_TEST_GUIDE.md) — Playwright E2E Tips
- [SECURITY_CHECK_GUIDE.md](./SECURITY_CHECK_GUIDE.md) — セキュリティ CI 対処法

---

**最終更新**: 2026-05-22 (PR #425 ベース)

**関連 KDD**:
- §5.X+44 (CSP graceful degradation の 2 段階修正)
- §5.X+58 (E2E coverage 漏れの CI fail)
- §5.X+82 (Supabase DB 接続 URL 2 種類設定)
- §5.X+86〜+88 (security-check.ts SQL injection / Remote property injection)
- §5.X+99 / §5.X+101 (Netlify Deploy Preview / NEXTAUTH_URL context 分離)
- §5.X+100 (Stripe paymentMethod 切替 UI / 請求堅牢性)
- §5.X+103 (Stripe Checkout cookie sameSite)
- §5.X+105 / §5.X+106 (Stripe Subscription cancel / idempotencyKey)

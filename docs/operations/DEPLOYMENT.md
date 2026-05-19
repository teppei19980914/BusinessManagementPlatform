# Netlify デプロイ手順 (Operations)

本ドキュメントは、Netlify への本番デプロイ手順を集約する (Vercel から 2026-05-18 に移行)。
障害対応は [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md)、ロールバックは [ROLLBACK.md](./ROLLBACK.md) を参照。

> **移行の背景**: Vercel Hobby プランは規約上商用利用不可のため、6/1 正式リリース (Expert/Pro 課金プラン稼働) に備えて Netlify Starter (商用 OK) へ移行した。詳細は [`docs/design/INFRASTRUCTURE.md §10`](../design/INFRASTRUCTURE.md) を参照。

---

## 1. Netlify 設定ファイル (`netlify.toml`)

リポジトリルートの [`netlify.toml`](../../netlify.toml) で全設定を一元管理。

```toml
[build]
  command = "pnpm build"                     # = "prisma generate && next build"
  publish = ".next"
  ignore = "bash scripts/netlify-ignore.sh"  # docs-only 変更は skip

[build.environment]
  NODE_VERSION = "22"

[[plugins]]
  package = "@netlify/plugin-nextjs"          # Next.js 16 App Router 公式 Runtime
```

### 1.1 ビルドコマンド

`package.json` の `"build"` スクリプトは `prisma generate && prisma migrate deploy && next build` の 3 段構成 (Netlify 側は `pnpm build` を呼ぶだけで OK)。

**PR-V8.1 (2026-05-19) 改訂**: マイグレーションは **build に含める** (= 自動適用) に方針変更。
旧設計は「手動実行で慎重に」だったが、PR-V7a で migration 適用漏れにより `billing-overdue-alert` が 500 (`payment_due_date` カラム不在で SQL error) になる事故が発生。

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

### 2.1 Secret マーキング

機密値 (DB パスワード / API キー / NEXTAUTH_SECRET / CRON_SECRET 等) は **Secret 扱い**で登録する:

```bash
netlify env:set KEY_NAME "value" --secret \
  --context production --context deploy-preview --context branch-deploy
```

> Netlify CLI v26 以降、`--secret` 利用時は **非 dev context を明示指定必須**。

### 2.2 一括登録 (移行・引き継ぎ時)

リポジトリ外に `.env.netlify-prod` を作成し、`netlify env:import` で一括投入する手順は [`docs/operations/ENV_VARS.md §3`](./ENV_VARS.md) を参照。

---

## 3. 通常デプロイ (スキーマ変更を含まない場合)

**前提**: Netlify サイトは GitHub リポジトリと接続済み (Admin URL: <https://app.netlify.com/projects/tasukiba>)。

```bash
# 1. 機能ブランチで作業
git checkout -b feat/xxx
# ... 編集 ...
git add .
git commit -m "feat: xxx"
git push -u origin feat/xxx

# 2. GitHub で Pull Request を作成
#    → Netlify が Deploy Preview を自動生成 (URL: deploy-preview-NNN--tasukiba.netlify.app)
#    → 既存の docs だけの変更なら scripts/netlify-ignore.sh で skip される

# 3. レビュー後、main にマージ
#    → Netlify が main の Production Deploy を自動生成
#    → Locked Deploy 設定 (§5) が有効なら手動 Publish が必要

# 4. 本番 URL (https://tasukiba.netlify.app) にアクセスし動作確認
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
5. デプロイ完了後、<https://tasukiba.netlify.app> にアクセスし動作確認

### 4.2 破壊的変更 (DROP / RENAME) の場合

旧コードと新コードがしばらく併存することを考慮し、**2 段デプロイ** を検討:
- PR (a): 新旧両対応のコードをマージ + マイグレーションは後回し
- Supabase で手動マイグレーション適用
- PR (b): 旧列への参照を削除

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

### 6.1 設定対象 (7 件)

旧 `vercel.json` から移行した cron schedule:

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

### 6.2 cron-job.org 設定手順

1. <https://cron-job.org/en/signup/> でアカウント作成 (無料、cron 数無制限)
2. 「Create cronjob」を 8 件作成、各々以下を設定:
   - **URL**: `https://tasukiba.netlify.app/api/cron/xxx`
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

super_admin として `https://tasukiba.netlify.app/admin/super/cron-history` にアクセスすると、社内 dashboard で:

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
  https://tasukiba.netlify.app/api/cron/daily-notifications
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

**根本原因**: NextAuth v5 0-beta.31 + @netlify/plugin-nextjs の組合せで `POST /api/auth/session` のレスポンス cookie がプロキシ層に吸収される (一次ソース未検証、ヘッダ観察で再現確認)。Vercel 環境では発生しない。

**対応 (本サービスで実施済)**:

- **PR #395**: 画面テーマは専用 cookie `tasukiba-theme` に分離。`src/app/api/settings/theme/route.ts` が DB 更新後に直接 Set-Cookie。
- **PR #396**: MFA 検証 / テナント TZ-Locale は **JWT 直接再署名**方式に切替 (`src/lib/auth-jwt-helper.ts` の `reissueAuthJwtOnResponse`)。クライアント側の `update()` 呼出しは削除。

**新規コードのルール**:

- **`useSession().update()` を新規追加しない**。同等の更新は以下のいずれかで実現:
  - **専用 cookie**: 値が SSR / middleware のみで読まれる場合 (例: テーマ)
  - **JWT 直接再署名**: middleware / useSession / SSR の複数経路で読まれる場合 (例: MFA / TZ / Locale)
- 詳細パターンは [docs/knowledge/KDD_PATTERNS.md §5.X+66](../knowledge/KDD_PATTERNS.md) を参照。
- 障害対応手順は [INCIDENT_RESPONSE.md §6.11](./INCIDENT_RESPONSE.md) を参照。

### 8.2 統合 credits 制限 (300 credits/月) の運用

2026 年から Netlify Free plan の制限単位は「ビルド分」から「統合 credits」に変更された。Production deploy / Web requests / Compute / Bandwidth / AI inference のすべてが credits を消費する単一枠 (Free = 300/月)。

| 主な consumer (実測ベース、本サービス) | 単位コスト | 月間想定 (6/1 リリース直後フェーズ) |
|---|---|---|
| Production deploy | ~15 credits/回 | 10-15 回 = 150-225 credits |
| Deploy Preview (PR) | ~15 credits/回 | 5-10 回 = 75-150 credits |
| Web requests | 0.25 credits/1000 req | 数万 req = 数 credits |
| Bandwidth / Compute / AI | 微小 | 数 credits |

**1 deploy あたり ~15 credits** が支配的なので、deploy 回数を抑える運用が credits 節約に直結する:

- `scripts/netlify-ignore.sh` で docs-only PR は build を skip (= credits 0 消費)
- WIP PR は draft 状態 / `[skip netlify]` で Deploy Preview を抑制
- ローカル `pnpm dev` で済む変更は push しない

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

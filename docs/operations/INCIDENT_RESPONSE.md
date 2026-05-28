# 障害対応とロールバック (Operations)

本ドキュメントは、本番障害発生時の対応手順とロールバック手順を集約する。

> **2026-05-16 更新**: 1 人運用 (teppei) での 6/1 リリース後を想定した重大シナリオを追加。
> 既存の §6.1〜§6.5 (ビルド / DB / migration / ローカル / ログイン) に加え、
> §6.6〜§6.10 で **LLM コスト爆発 / テナント越境 / 月初 cron / Supabase 全停止 / データ漏洩疑い** を追加。

---

## §0. 初動の共通 3 ステップ

障害発生通知を受けたら、どのシナリオでも **まずこの 3 ステップ** を実施。

### Step 0-1: 状況の客観化 (5 分以内)

- **何が起きているか**: ユーザ報告 / 監視通知 / 自分が気づいた、いずれか
- **影響範囲**: 全テナント / 特定テナント / 特定ユーザ / 特定機能 / 特定画面
- **発生時刻**: タイムスタンプを記録 (post-mortem の足場)
- **緊急度の暫定判定**: §0-3 の重大度表に照らす

### Step 0-2: タイムライン記録の開始

post-mortem を後で書くために、対応中に行った操作・確認したログ・実行した SQL を全てメモ。
最低限以下のフォーマットで時系列を残す:

```
HH:MM 通知受信: 内容
HH:MM 確認: Netlify Function ログで X を確認、エラー数 Y 件
HH:MM 対処: SQL `UPDATE ... SET ...` を実行 (影響行数 Z)
HH:MM 結果: 通常動作確認 / 引き続き調査
```

### Step 0-3: 重大度分類

| 重大度 | 定義 | 例 | 初動目標 |
|---|---|---|---|
| **S-1: 致命的** | 個人情報漏洩 / データ破壊 / 全テナント停止 | テナント越境バグ顕在化、Supabase 全停止、データ漏洩疑い | 30 分以内に応急対応開始 |
| **S-2: 重大** | 主要機能停止 / 特定テナント全停止 / 経済的損失リスク | LLM コスト爆発、月初 cron 失敗、認証停止 | 2 時間以内に応急対応 |
| **S-3: 中** | 一部機能不動 / 一部ユーザ影響 / 軽微な誤動作 | 特定画面のみ 500、特定機能のテスト失敗 | 当日中に対応 |
| **S-4: 軽** | 機能には影響なし / 表示の崩れ等 | 軽微な UI ズレ、ログの警告 | 通常 PR で対応 |

**判断に迷ったら 1 段階上に分類**。後から下げるのは安全だが、低く分類して放置すると事故になる。

### Step 0-4: CI / E2E 大量失敗時のシグナル認識 (2026-05-28 fix/tenant-id-default-removal post-mortem 起因)

PR を push して CI が落ちたとき、**「ほぼ全 spec が 0ms で fail」** のパターンが見えたら、個別 spec のロジック問題ではなく **beforeAll / global setup 系の失敗** を真っ先に疑う。

| 症状パターン | 真因の傾向 | 確認すべきこと |
|---|---|---|
| **全 spec が 0ms で fail** (テスト本体が一度も実行されていない) | beforeAll / global setup が throw、または fixture が初期 admin 等を作れていない | seed.ts / e2e fixtures / migration の SQL を確認、特に `INSERT INTO` に **NOT NULL 列の渡し忘れ** が無いか |
| **特定 spec のみ 0ms で fail** | その spec の beforeAll / fixture 固有の失敗 | 該当 spec の beforeAll を読む |
| **大半 PASS で一部 fail** (実行時間あり) | 個別ロジックの問題 (本来の test failure) | 個別 spec ロジックを修正 |
| **全 spec が timeout で fail** | webServer / DB / network 全体不通 | port 競合 / 環境変数 / DB 起動状態を確認 |
| **CI のみ fail、ローカル PASS** | DB schema / 環境変数の差分、CI でのみ走る migration / fixture が壊れている | CI ログで `prisma migrate deploy` / fixture セットアップ ステップを確認 |

**実例**: 2026-05-28 fix/tenant-id-default-removal で schema から DB DEFAULT を撤去した際、`e2e/fixtures/db.ts` の raw SQL が `tenant_id` を渡しておらず NOT NULL 違反 → 初期 admin 不在 → **204 spec 中 200+ が 0ms fail** という症状で表面化した。本パターンは [docs/knowledge/KDD_PATTERNS.md §5.X+170](../knowledge/KDD_PATTERNS.md) で詳述。

---

## §6. 障害対応

## 6. 障害対応

### 6.1 Netlify ビルド失敗

#### 症状
- Netlify Dashboard → Deployments のステータスが **Failed**
- "Build Command" のログにエラー

#### 調査手順

1. Netlify Dashboard → 該当 Deployment → **Build Logs** を開く
2. 最後のエラー行を特定

#### よくある原因と対処

| 症状 | 原因 | 対処 |
|---|---|---|
| `Cannot find module '@/generated/prisma'` | `pnpm prisma generate` が未実行 (buildCommand のどこかで失敗) | `netlify.toml` の `[build] command` が `pnpm prisma generate && pnpm build` のままか確認 |
| `DATABASE_URL is not defined` | Netlify 環境変数未設定 | Project Settings → Environment Variables で `DATABASE_URL` / `DIRECT_URL` 等を設定。Production / Preview / Development それぞれにスコープ指定 |
| `Type error: ...` (TypeScript) | 型エラー | ローカルで `pnpm build` を事前実行して同じエラーを再現し、コード側で修正 |
| ESLint エラー | lint ルール違反 | ローカルで `pnpm lint` を実行して修正 |

### 6.2 DB 接続失敗 (アプリ起動時)

#### 症状
- Netlify Function ログに `PrismaClientInitializationError` や `Connection terminated unexpectedly`
- `/settings` 等の DB 依存ページで 500 エラー

#### 対処

1. Netlify Dashboard → Deployment → **Runtime Logs** でエラーメッセージを特定
2. 接続 URL の確認:
   - `DATABASE_URL` が **Pooler URL** (`pooler.supabase.com:6543` + `?pgbouncer=true`) になっているか
   - `DIRECT_URL` が **直結 URL** (`db.[ref].supabase.co:5432`) になっているか
3. Supabase Dashboard → Database → **Roles** で `postgres` パスワードが変更されていないか確認 (変更時は全環境変数を更新)
4. Supabase 側の **Project Pause**: Free プランは 1 週間アクセスがないと自動 pause される。Dashboard から **Resume** する

### 6.3 マイグレーション失敗

#### 症状
- Supabase SQL Editor で `ERROR: ...` が返る
- 本番で `column X does not exist` / `relation Y does not exist`

#### 対処

| エラー | 原因 | 対処 |
|---|---|---|
| `ERROR: 42601: syntax error at or near "prisma"` | SQL 本文ではなくファイルパスを貼付 | **ファイル内の SQL テキストを丸ごとコピー** して貼付 (README の警告参照) |
| `ERROR: 42703: column "X" of relation "Y" does not exist` | 過去のマイグレーションが未適用 | §4 のマイグレーション一覧で未適用を特定 → 古い順に 1 件ずつ SQL Editor で実行 |
| `ERROR: 42P01: relation "X" does not exist` | 同上、もしくはテーブル名の typo | §4 第 8 番 (`20260418_visibility_and_risk_nature`) の既知事案 (`knowledge` vs `knowledges`) は特に要注意 |
| `ERROR: 42710: extension "pg_trgm" already exists` | 2 回目以降の適用 | `CREATE EXTENSION IF NOT EXISTS` なら無視してよい。`IF NOT EXISTS` 無しなら既に適用済みの証拠 |

### 6.4 ローカル開発で `pnpm dev` 起動失敗

| 症状 | 原因 | 対処 |
|---|---|---|
| `Error: P1001: Can't reach database server` | ローカル PostgreSQL が起動していない | Docker Compose を起動、もしくは `DATABASE_URL` を Supabase のものに切替 |
| `Error: P2021: The table ... does not exist` | マイグレーション未適用 | `npx prisma migrate dev` を実行 |
| `next dev` 起動後 `http://localhost:3000` で 500 | `NEXTAUTH_SECRET` 未設定 | `openssl rand -base64 32` で生成して `.env` に設定 |

### 6.5 ログイン失敗の調査手順 (PR fix/login-failure / 2026-05-03)

ユーザから「ログインできない」報告があった場合の系統的な調査手順。**Netlify Function のリクエストログだけでは原因が分からない**ため、`auth_event_logs` テーブルと Netlify Function ログ (`console.error`) を併用する。

#### Step 1: 本番 Supabase で `auth_event_logs` を確認

最も確実な方法。`detail.reason` に失敗理由が記録されている。

```sql
-- 直近のログイン失敗を確認 (Supabase SQL Editor で実行)
SELECT
  created_at,
  email,
  detail->>'reason' AS reason,
  user_id
FROM auth_event_logs
WHERE email = '<対象メールアドレス>'
  AND event_type = 'login_failure'
ORDER BY created_at DESC
LIMIT 10;
```

`detail.reason` の値と意味:

| reason 値 | 意味 | 対処 |
|---|---|---|
| `user_not_found` | メールアドレスのアカウントが存在しない | メールアドレスのスペル確認、別アカウントの可能性 |
| `inactive` | `users.is_active=false` で非活性 | 後述の「非活性アカウントの再活性化」 |
| `permanent_lock` | `users.permanent_lock=true` (永続ロック) | 後述の「永続ロックの解除」 |
| `temporary_lock` | `users.locked_until > now()` (一時ロック中) | 30 分待機 or admin 解除 |
| `invalid_password` | bcrypt 比較失敗 (パスワード違い) | ユーザにパスワードリセットを案内 |

#### Step 2: Netlify Function ログで `[auth]` プレフィックスを確認

`auth_event_logs` の書き込みに失敗している場合 (DB 接続不能等) は Netlify Function ログのみが頼り。

```
Netlify Dashboard → 対象プロジェクト → Logs → 検索バーに `[auth] login_failure` を入力
```

ログに `reason` フィールドが含まれている (PR fix/login-failure 以降)。Email は `tep***@gmail.com` 形式でマスク表示される。

#### Step 3: 個別の対処

##### 非活性アカウントの再活性化

```sql
UPDATE users
SET is_active = true
WHERE email = '<対象メールアドレス>';
```

##### 永続ロックの解除

```sql
UPDATE users
SET permanent_lock = false,
    temporary_lock_count = 0,
    failed_login_count = 0,
    locked_until = NULL
WHERE email = '<対象メールアドレス>';
```

##### 一時ロックの即時解除

```sql
UPDATE users
SET locked_until = NULL,
    failed_login_count = 0
WHERE email = '<対象メールアドレス>';
```

##### パスワードのリセット (admin 経由、最終手段)

ユーザにパスワードリセット URL を送信する正規ルートが推奨。直接 DB を更新する場合は bcrypt で再ハッシュ:

```typescript
// scripts/reset-password.ts (要 bcryptjs)
import { hash } from 'bcryptjs';
import { prisma } from '@/lib/db';
const hashed = await hash('<新パスワード>', 10);
await prisma.user.update({
  where: { email: '<対象メールアドレス>' },
  data: { passwordHash: hashed, forcePasswordChange: true },
});
```

`forcePasswordChange=true` をセットして、次回ログイン時に再変更を強制する。

#### Step 4: UX 改善状況 (PR fix/login-failure 以降)

非活性アカウントは login UI で **「このアカウントは無効化されています」** と専用メッセージが出る (旧仕様: 「メールアドレスまたはパスワードが正しくありません」と誤表示で原因不明の状態だった)。`/api/auth/lock-status` が `status: 'inactive'` を返す経路で実現。

### 6.6 LLM API コスト爆発 / レート超過 (S-2)

#### 症状
- Anthropic / Voyage の dashboard で当月使用量が異常急増
- `ApiCallLog` テーブルで特定テナント / 特定 user の呼び出しが急増
- 一部ユーザから「提案エンジンが遅い / エラー」報告

#### 調査手順

```sql
-- 直近 24h で呼び出し数 TOP の tenant / user / featureUnit
SELECT
  tenant_id,
  user_id,
  feature_unit,
  COUNT(*) AS call_count,
  SUM(jpy_amount) AS total_jpy
FROM api_call_logs
WHERE created_at > now() - interval '24 hours'
GROUP BY tenant_id, user_id, feature_unit
ORDER BY call_count DESC
LIMIT 20;
```

#### 対処

| 状況 | 対処 |
|---|---|
| 特定 tenant の正常利用が想定を超えた | プラン上限到達後は **縮退モード** で自動停止 (ADR-0002)。tenant の `monthlyBudgetCapJpy` 設定を確認 |
| 特定 user が連打 (悪用疑い) | Netlify Function ログで `[suggest]` プレフィックスから IP / User-Agent 確認 → 必要なら admin 経由で user `is_active=false` |
| Anthropic / Voyage 全体のレート超過 | プロバイダ dashboard で workspace 全体の月間ハード上限を一時的に引き下げ。サービス全体で提案エンジンを `503` 返却するフィーチャーフラグを検討 |
| 想定外の bulk 呼出 (memory: feedback_bulk_llm_call_unit 違反) | 該当箇所の `withMeteredLLM` ラップ単位を確認、1 業務操作 = 1 ApiCallLog に集約されているか検証 |

#### 予防

- 監視: テナント単位の月次使用量を **毎日朝確認** (操作ルーチン化)
- Anthropic workspace の月間ハード上限を想定使用量の 1.5〜2 倍に設定 ([STRIDE_REVIEW_PROCEDURE.md](../security/STRIDE_REVIEW_PROCEDURE.md) D-1 多重防御)

### 6.7 テナント越境バグ顕在化 (S-1)

**個人情報漏洩相当**。発覚した時点で平時の作業を中断し、本シナリオを最優先で実施。

#### 症状

- ユーザから「他テナントのデータが見えた」報告
- 監査ログで「別 tenant_id の data に対する read 操作」を検知
- E2E テストで cross-tenant fixture の漏洩を検出

#### 対処 (時系列)

1. **即時(30 分以内)**:
   - 漏洩経路となった API ルート / Service 関数を特定
   - 該当機能の **緊急停止** を判断: feature flag で OFF、もしくは Netlify Rollback (Publish deploy) で前バージョンに戻す
   - 漏洩範囲の SQL 調査 (`audit_logs` から該当時刻周辺の cross-tenant access 件数を抽出)
2. **当日中**:
   - 影響を受けたユーザ・テナントの特定リストを作成
   - 該当ユーザに **個別通知** (Slack の admin 直接連絡 or メール)
   - 修正 PR を起票 ([ADR-0005](../adr/0005-rbac-two-stage-tenant-authorization.md) の 二段階認可に違反していないか再確認)
3. **48 時間以内**:
   - 法的対応の検討 (個人情報保護法に基づく報告義務の有無を判断)
   - Post-mortem ドキュメント作成 (§9)
   - 同型の越境バグが他箇所にないか **横展開チェック** ([CONTRIBUTING.md §5.1 + §5.2](../../CONTRIBUTING.md))

#### 重要な対応原則

- **データを消すな、隠せ**: 漏洩データを削除するのではなく、まず該当機能を停止して新規漏洩を止める
- **証拠は保全**: `audit_logs` / Netlify Function ログ / DB snapshot を即座にエクスポート (post-mortem と法的対応の根拠)
- **隠蔽するな**: 1 人運用でも、影響ユーザへの通知は必ず行う

#### 予防 (PR レビュー時)

- 一覧系サービスに `viewerTenantId` の必須引数化 (memory: feedback_tenant_isolation)
- E2E spec で「別テナントのデータが見えない」テストを各画面で必ず追加
- **schema レベル**: `tenantId String` カラムに DB DEFAULT を絶対に持たせない (ADR-0024 / 2026-05-28 silent fall-through バグ参照)
- **service レベル**: `prisma.X.create({ data: { tenantId, ... } })` の data に tenantId を必ず明示
- 詳細は [docs/design/SECURITY.md §26 テナント分離検証](../design/SECURITY.md)

#### 実例: 2026-05-28 silent fall-through インシデント

**症状**: testテナントの一般ユーザが起票した課題が「一覧に出ない」報告。システム管理者ダッシュボードでも 0 件表示。

**直接原因**: `src/services/risk.service.ts:460 createRisk` と `retrospective.service.ts:304 createRetrospective` が `data` に `tenantId` を渡しておらず、schema の DB DEFAULT (Default テナント) に silent 混入していた。

**対応**:
1. コード fix (`data: { tenantId, ... }` 追加)
2. schema cleanup (13 モデルから DB DEFAULT 撤去 + migration)
3. データ修復 (`scripts/migrate-leaked-tenant-data.ts --apply` で Default テナント混入レコードを起票者の本来テナントに UPDATE)
4. E2E regression test 追加

詳細: [post-mortems/2026-05-28-tenant-id-default-silent-fallthrough.md](./post-mortems/2026-05-28-tenant-id-default-silent-fallthrough.md)

### 6.8 月初 cron バッチ失敗 (S-2)

#### 影響

毎月 1 日の cron バッチは以下を担当 (ADR-0002 / SUGGESTION_ENGINE.md §B-4):
- 縮退モード中に生成されなかった NULL embedding の補完
- プラン切替予約 (legacy) の適用 — 2026-05-14 改修で新規予約パスは廃止 (全プラン変更が即時反映、Beginner ダウングレードは完全禁止)。月初 cron 内の処理は残置 DB レコード対策
- 当月の課金確定 (LLM per-call SUM + DB 容量 peak + ファイルストレージ peak)

失敗するとテナント月次利用履歴が不整合になり、**誤請求 / 縮退モードからの復帰失敗** のリスク。

#### 症状

- cron-job.org Dashboard でジョブが `Failed`
- `tenant_monthly_usage_history` に当月行が無いテナントが残る
- 提案エンジンで「Beginner プラン上限到達」が解除されない

#### 対処

```bash
# 外部 cron (cron-job.org) の手動再実行 (cron-job.org Dashboard から、または curl で endpoint を叩く)
curl -X POST https://<production-domain>/api/cron/monthly-batch \
  -H "Authorization: Bearer $CRON_SECRET"
```

スクリプト経由のリカバリ:

```bash
# 一部処理のみ手動実行する場合
pnpm tsx scripts/backfill-monthly-embeddings.ts --tenant=<id>
# (現状未実装。必要なら作成: scripts/README.md の「運用・緊急対応」カテゴリ)
```

#### 完了後の検証

- 全テナントについて `tenant_monthly_usage_history` の当月行が存在
- 課金確定後の合計値と `api_call_logs` の集計が一致 (memory: feedback_billing_data_realtime — ダッシュボード遷移時に再集計)
- Beginner プランのテナントで縮退モードが解除されている

### 6.9 Supabase 全面障害 (S-1)

#### 症状

- すべての DB 依存ページが 500
- Supabase Status Page (https://status.supabase.com/) で障害告知
- Netlify Function ログに `Connection terminated unexpectedly` が大量

#### 対処

| フェーズ | 対応 |
|---|---|
| 初動 | Supabase Status Page で公式情報を確認。**焦って手元で何か触らない** (DB 接続バーストが復旧を遅らせる) |
| 復旧待機 | Netlify Dashboard で `Maintenance mode` 表示の static page にフォールバックする feature flag を有効化 (要事前準備、未実装なら手動で `_offline.html` を出すルートを追加) |
| 部分復旧 | Supabase が部分復旧したら read-only モードで動作確認。書き込みは Status Page が「Resolved」になるまで待つ |
| 全面復旧 | `pnpm prisma migrate status` で migration 整合性確認、`SELECT count(*) FROM users` 等で接続性確認 |

#### 連絡

ユーザ向け告知が必要な規模なら、登録メール宛に **「障害発生 → 復旧見込み」** を送信 (テンプレートは §8 参照)。

#### 予防 (将来検討)

- AWS RDS / Azure Database for PostgreSQL への移行余地を確保 ([ADR-0004](../adr/0004-postgresql-prisma.md))
- Supabase Pro プラン (point-in-time recovery + SLA) へのアップグレード判断

### 6.10 データ漏洩疑い (S-1)

外部からの「データが流出している」連絡、または社内で「これは漏れたかも」と気づいた場合。

#### 即時対応 (1 時間以内)

1. **証拠保全**: `audit_logs` / `auth_event_logs` / Netlify Function ログを即座にエクスポート、別 storage に保管
2. **侵入経路の遮断**: 疑わしい API キーがあれば即時 rotate (Netlify 環境変数で再生成)
3. **影響範囲の特定**:
   - SQL で漏洩疑いデータの read/write access 履歴を抽出
   - 流出規模 (件数 / 機微度) の暫定見積もり

#### 当日中

- 影響を受けたユーザの特定リスト作成
- 法的対応の必要性判断 (個人情報保護委員会への報告義務の有無)
- 公的窓口の連絡先: [個人情報保護委員会 報告フォーム](https://www.ppc.go.jp/personalinfo/legal/leakAction/)

#### 48 時間以内

- 影響ユーザへの通知 (テンプレートは §8 参照)
- Post-mortem ドキュメント作成 (§9)
- セキュリティ強化 PR の起票
- 再発防止策の検討 ([STRIDE_REVIEW_PROCEDURE.md](../security/STRIDE_REVIEW_PROCEDURE.md) を一時的に再実施)

### 6.11 MFA 検証成功してもログインループ (S-2、Netlify 移行起因)

MFA 有効ユーザが TOTP コードを正しく入力しても `/login/mfa` 画面に戻され続ける症状。super_admin はログイン不能に陥るためサービス継続に影響する S-2 障害。

#### 既知の根本原因

NextAuth v5 0-beta.31 + @netlify/plugin-nextjs の組合せで `POST /api/auth/session` の Set-Cookie がブラウザに反映されない事象 (KDD §5.X+66)。**2026-05-18 の PR #396 で JWT 直接再署名方式に切替え済**。再発した場合は本方式が壊れた可能性を疑う。

#### 切り分け手順

1. **発生条件の確認** (5 分):
   - DevTools → Network タブで `POST /api/auth/mfa/verify` のレスポンスを開く
   - **Response Headers に `set-cookie: __Secure-authjs.session-token=...`** が含まれているか確認
   - 含まれていない → 6.11 のパターン確定。`src/lib/auth-jwt-helper.ts` の動作不良か、NextAuth `next-auth/jwt` API 変更を疑う
   - 含まれている → 別原因 (middleware / `mfaPending` 判定ロジック等)

2. **JWT 再署名の動作確認** (10 分):
   ```bash
   pnpm vitest run src/lib/auth-jwt-helper.test.ts
   ```
   8 件全 pass を確認。fail がある場合 → ヘルパに依存する全機能 (MFA / TZ / Locale) が影響を受けるため即時調査。

3. **環境変数の検証** (5 分):
   - Netlify 環境変数 `NEXTAUTH_SECRET` が設定されていることを確認 (helper 内で必須)
   - 値が auth.config.ts の `secret` と一致しているか (Netlify UI で再確認)

#### 暫定回避策 (本番ユーザ向け)

JWT 再署名が壊れていてもユーザが脱出できる経路:

- **recovery code を使う**: MFA TOTP の代わりにリカバリーコードを入力 → 成功すれば同じく JWT 再署名される (recovery code 経路も同ヘルパで再署名するため、TOTP 経路だけが特定の理由で壊れている場合は recovery code でも回避できない可能性あり)
- **super_admin に手動で MFA をリセットしてもらう**: `POST /api/auth/mfa/disable` を super_admin が呼ぶ (該当ユーザ ID 指定)。MFA 強制対象 (super_admin 自身) には適用不可
- **最悪ケース (super_admin 自身がロック)**: Supabase ダッシュボードで直接 `users` テーブルの `mfaEnabled` を false に SET。次回ログインで MFA をスキップしてサービス復旧。**事後に必ず MFA を再有効化する**こと。

#### 恒久対応

- NextAuth v5 GA 待ち → `useSession().update()` の Set-Cookie 反映を upstream で fix されたら再評価
- 別ホスティング (Netlify Pro / AWS Amplify 等) への昇格検討は `docs/design/INFRASTRUCTURE.md §10.3` のスケール時方針として整理済

### 6.12 誤ユーザログイン事象を観測 (S-1、Netlify Set-Cookie 脱落起因)

ユーザ A でログアウト後、別ユーザ B の credentials を入力してログインしたつもりが、**ユーザ A の状態 (テナント / 権限) でログイン継続される**症状。個人情報漏洩リスクのある S-1 障害。

#### 既知の根本原因

NextAuth v5 0-beta.31 + @netlify/plugin-nextjs の組合せで `POST /api/auth/signout` の `Set-Cookie: Max-Age=0` がブラウザに反映されない事象 (KDD §5.X+84、§5.X+66 の派生)。**2026-05-20 の PR #415 で `POST /api/auth/explicit-signout` + DB `tokenVersion` increment + login pre-clear の三重防御に切替済**。再発した場合は本方式が壊れた可能性を疑う。

#### 切り分け手順

1. **再発状況の確認** (5 分):
   - 報告ユーザに「ログアウト後、DevTools > Application > Cookies で `__Secure-authjs.session-token` / `authjs.session-token` / `tasukiba-theme` が消えているか」を確認依頼
   - 消えていない → §6.12 のパターン確定 (Set-Cookie 脱落復活)
   - 消えている → 別経路 (例: 別端末 / 別ブラウザでの古いセッション温存) を疑う

2. **server-side 失効が動作しているかの確認** (5 分):
   - 該当ユーザの `user.tokenVersion` を Supabase で確認:
     ```sql
     SELECT id, email, token_version, last_login_at, updated_at
     FROM users WHERE email = '<該当ユーザ>';
     ```
   - 報告時刻の前後で `token_version` が **+1 されていれば**: server-side では正しく失効されている (= cookie 残留はあっても次回 API で 401)。報告ユーザがブラウザを再起動すれば解消の可能性高い
   - **+1 されていない** → explicit-signout route 自体が失敗している。Netlify Functions logs で `[explicit-signout] failed` 行を検索

3. **CI ガード状況の確認** (3 分):
   - 最近のマージ PR で `pnpm check:banned-auth-patterns` が緑だったか確認
   - 直近で `signOut from 'next-auth/react'` や `/api/auth/signout` 直接 fetch が混入していないか (ガード回避コメント `// banned-auth-allow:` の濫用も含めて)

#### 応急対応

- **個人情報漏洩リスクの確認**: `auth_event_logs` テーブルで報告時刻前後の `logout` / `login_success` イベントを抽出し、誰のセッションがどう推移したかを再現
  ```sql
  SELECT event_type, user_id, tenant_id, email, ip_address, created_at
  FROM auth_event_logs
  WHERE created_at >= '<報告時刻-1時間>'
    AND created_at <= '<報告時刻+1時間>'
  ORDER BY created_at;
  ```
- **影響ユーザの強制ログアウト**: 該当ユーザ全員の `token_version` を一括 +1 (= 全セッション無効化)
  ```sql
  UPDATE users SET token_version = token_version + 1
   WHERE id IN ('<影響ユーザ ID list>');
  ```
- **PR 単位の rollback 判断**: 直近の認証関連 PR がトリガになっていないか、`git log --oneline -- src/app/api/auth/ src/lib/page-auth.ts src/middleware.ts` で確認

#### 恒久対応

- explicit-signout route + requireAuthForLayout の組合せが壊れていないか整合性確認 (KDD §5.X+84 参照)
- 必要なら CI ガード `scripts/check-banned-auth-patterns.ts` の検出パターンを強化
- 中長期: DB セッション (NextAuth `strategy: 'database'`) への移行検討 (MVP 後ロードマップ)

#### Post-mortem 必須事項

S-1 のため、解決後は以下を必ず実施:

- 影響ユーザへの通知 (テンプレートは §8 参照)。**「ユーザ A の操作がユーザ B のデータに影響した可能性」を正直に開示**
- `auth_event_logs` + `audit_logs` から、影響期間中の write 操作を全件レビューしデータ整合性を確認
- Post-mortem ドキュメント作成 (§9)
- 個人情報保護法上の通報要否を法務観点で確認 (本サービスは個人情報を扱うため、漏洩確証時は個人情報保護委員会への報告義務あり)

---


## §7. ロールバック手順

## 7. ロールバック手順

### 7.1 Netlify の前バージョンへのロールバック (コードのみ)

Netlify の **Publish deploy** 機能を使う。DB マイグレーションは巻き戻らない点に注意。

#### 手順

1. Netlify Dashboard → 対象 Site → **Deploys** タブ
2. 戻したいバージョン (緑の **Published** バッジが付いた過去のデプロイ) を選択
3. 右上の **Publish deploy** をクリック (Netlify UI のバージョンにより **Restore** と表記される場合あり、要確認)
4. 即座に本番 URL が指定バージョンに切り替わる (新規ビルド不要、数秒〜数十秒)

**補足** (Netlify の公式仕様):
- 過去のデプロイは Personal プランで一定期間保持される
- Publish deploy はコードのみ。**DB スキーマは戻らない**

### 7.2 DB マイグレーションのロールバック

Prisma の migrate には down マイグレーションの機能がない (`prisma migrate dev` は forward のみ)。本番でスキーマを戻すには **逆 SQL を手動で書く** 必要がある。

#### 手順

1. 直近適用したマイグレーションの中身を確認

   ```bash
   pnpm migrate:print <migration-name>
   ```

2. 逆操作の SQL を手で書く。例:
   - `ADD COLUMN foo ...` → `ALTER TABLE xxx DROP COLUMN foo;`
   - `CREATE TABLE foo (...)` → `DROP TABLE foo;`
   - `CREATE INDEX foo ON ...` → `DROP INDEX foo;`
   - `UPDATE ... SET x = 'A' WHERE x = 'B'` → **戻せない可能性あり** (上書き情報の記録がない限り不可逆)

3. Supabase SQL Editor で実行

4. `prisma/migrations/_prisma_migrations` テーブル (要確認: Prisma 7 での実テーブル名) から当該行を削除

   ```sql
   DELETE FROM "_prisma_migrations" WHERE migration_name = '<migration-name>';
   ```

5. Netlify のコードも §7.1 で対応バージョンへ戻す

> ⚠ **破壊的操作** なので事前に Supabase Dashboard → Database → **Backups** で現状バックアップを取得してから実施。Supabase Free プランでも Point-in-Time Recovery (7 日) が使える (要確認)。

### 7.3 全面復旧 (バックアップからのリストア)

Supabase Dashboard → Database → **Backups** タブで過去のスナップショットから復旧する。要確認 (現プロジェクトで実施したことがあるか、本書では記録なし)。

---

## §8. エスカレーションと通知テンプレート

### 8.1 連絡先 / エスカレーション先

| 状況 | 連絡先 | 連絡手段 |
|---|---|---|
| プロダクトオーナー | teppei (本人) | — |
| Supabase 障害 | Supabase Support (Pro プラン以上) | Dashboard → Support |
| Anthropic API 障害 | Anthropic Support | https://support.anthropic.com/ |
| Voyage AI 障害 | Voyage AI Support | support@voyageai.com |
| Netlify 障害 | Netlify Status | https://www.netlifystatus.com/ |
| Brevo (メール) 障害 | Brevo Support | dashboard 内 |
| Stripe 障害 | Stripe Status | https://status.stripe.com/ |
| 法的対応 (個人情報漏洩) | 個人情報保護委員会 | https://www.ppc.go.jp/personalinfo/legal/leakAction/ |

### 8.2 ユーザ通知テンプレート

#### A. 障害発生時の初報 (発生中、復旧未定)

> 件名: 【たすきば Knowledge Relay】サービス障害のお知らせ
>
> いつもご利用ありがとうございます。
> 現在、〇〇機能において障害が発生しており、ご利用いただけない状態となっております。
>
> - 発生時刻: YYYY-MM-DD HH:MM (JST)
> - 影響範囲: 〇〇機能 / 全機能
> - 原因: 調査中
> - 復旧見込み: 調査中 / HH:MM 頃見込み
>
> 復旧次第、改めてご連絡いたします。ご不便をおかけし誠に申し訳ございません。

#### B. 復旧時の続報

> 件名: 【たすきば Knowledge Relay】サービス障害復旧のお知らせ
>
> 〇〇 にてご連絡しておりました障害は、YYYY-MM-DD HH:MM に復旧いたしました。
>
> - 障害発生時刻: YYYY-MM-DD HH:MM
> - 復旧時刻: YYYY-MM-DD HH:MM
> - 影響範囲: 〇〇機能 / 全機能
> - 原因: 簡潔に (例: DB 接続障害 / cron バッチ失敗 / 設定不備)
> - 再発防止: 簡潔に (例: 〇〇監視を追加、〇〇手順を見直し)
>
> ご不便をおかけし誠に申し訳ございませんでした。今後とも、たすきば Knowledge Relay をよろしくお願いいたします。

#### C. データ漏洩通知 (S-1、法的根拠を意識)

データ漏洩が確定的になった場合のテンプレート。**送信前に法務確認推奨**。

> 件名: 【重要】たすきば Knowledge Relay におけるお客様データの漏洩について
>
> 〇〇株式会社 〇〇様
>
> このたび、たすきば Knowledge Relay におきまして、お客様のデータが第三者から閲覧可能な状態にあったことが判明しました。深くお詫び申し上げます。
>
> - 発生時刻: YYYY-MM-DD HH:MM
> - 発覚時刻: YYYY-MM-DD HH:MM
> - 影響範囲のデータ項目: (具体的に: メールアドレス / プロジェクト名 / ナレッジ内容 等)
> - 影響規模: 〇〇件
> - 原因: 簡潔に
> - 対応: 該当機能を即時停止しました。再発防止のため 〇〇 を実施します。
> - お客様にお願いしたいこと: パスワード変更等
>
> 個人情報保護委員会への報告も併せて実施しております。
> ご不安・ご質問は support@<domain> までお問い合わせください。

---

## §9. Post-mortem テンプレート

S-1 / S-2 の障害対応完了後、48 時間以内に作成する。
保存先: `docs/operations/post-mortems/YYYY-MM-DD-<short-slug>.md` (ディレクトリは初回作成時に追加)。

```markdown
# Post-mortem: <一行サマリ>

- **日付**: YYYY-MM-DD
- **重大度**: S-1 / S-2 / S-3
- **対応者**: teppei
- **影響時間**: HH:MM 〜 HH:MM (合計 〇分)
- **影響範囲**: 〇〇テナント / 全テナント / 〇〇機能 等

---

## サマリ (3 行以内)

<何が起き、どう対応したかの一行要約>

## タイムライン

| 時刻 | 出来事 |
|---|---|
| HH:MM | 通知受信: ... |
| HH:MM | 確認: ... |
| HH:MM | 対処: ... |
| HH:MM | 復旧確認: ... |

## 影響

- ユーザ影響: 〇〇人 / 〇〇テナントが 〇〇 できない状態
- データ影響: あり / なし (あれば詳細)
- 金銭影響: 〇〇 円相当 (LLM 過剰呼出など)

## 直接原因 (Direct Cause)

<コードの何が問題だったか、技術的な root cause>

## 根本原因 (Root Cause)

<なぜそのバグが生まれ、検知されずに本番に出たか — プロセス / 設計 / レビュー観点>

## 良かったこと

- 検知が早かった / 復旧手順が確立されていた / 監査ログから経路追跡できた 等

## 改善すべきこと (Action Items)

| # | アクション | 担当 | 期限 | 関連 PR/Issue |
|---|---|---|---|---|
| 1 | 監視: 〇〇 メトリクスのアラート追加 | teppei | YYYY-MM-DD | #XXX |
| 2 | レビュー観点: CONTRIBUTING.md §5.X に追記 | teppei | YYYY-MM-DD | #XXX |
| 3 | ナレッジ追加: docs/knowledge/KDD_PATTERNS.md §5.X | teppei | YYYY-MM-DD | #XXX |

## 関連

- 障害対応中のログ: <URL or attachment>
- 修正 PR: #XXX
- 関連 ADR: ADR-XXXX
- 関連脅威モデル: [docs/security/](../security/)
```

### Post-mortem の運用ルール

- **責めない文化** (memory: project_overview の哲学): 「個人を責める」ではなく「仕組み / プロセスをどう改善するか」に集中
- **Action Items は必ず PR / Issue に落とす**: 文書化だけで終わらせない
- **3 ヶ月後にフォローアップ**: 改善策が実施されているか四半期 STRIDE レビュー時に確認

---

## ADR-0025: Beginner プラン write block 関連 SOP (2026-05-29 追加)

### ユーザからの問い合わせ「Beginner で新規作成できない」

1. **状況確認**: テナント設定画面 (`/settings/tenant?tab=usage`) で容量バナー (Beginner 専用) を確認させる
2. **超過判定**: DB 50MB / Storage 100MB のいずれかが「無料枠超過 (write ブロック中)」表示なら ADR-0025 ガード発火中
3. **誘導**:
   - 即時復旧したい場合: 不要な資産 (Knowledge / 添付 / Memo) の削除を案内 → 削除後 30 秒以内に自動再集計 → 書込み可能に
   - 反映されない場合: 設定画面上部の `[DB 容量 / API 利用量を再集計]` ボタンを押下
   - Beginner プランを継続できない規模なら Expert プラン (¥10/call + ¥50/GB tier / ¥10/GB tier) へアップグレード誘導
4. **誤検知の確認**: `tenant.storageBytesUsed` が cron キャッシュ (最大 24h ズレ許容) のため、ユーザが認識している実使用量と乖離する可能性。super_admin の手動 recalc (`POST /api/admin/super/tenants/[id]/recalculate`) で即時更新可

### audit ログでの「skip 証跡」確認

月初 cron で Beginner overage が skip された場合、`auditLog` に `entityType='api_call_log_skip'` + `afterValue.adr='ADR-0025'` + `skipReason='beginner plan - overage charge waived per ADR-0025'` が記録される。「請求漏れの可能性」を疑われた際の証跡として使用。

詳細: [ADR-0025](../adr/0025-beginner-write-guard.md) / [仕様書 BEGINNER_PLAN.md](../specification/BEGINNER_PLAN.md)

---


# バックアップ検証手順

本ドキュメントは、本サービスのバックアップが **実際に復元可能であること** を定期的に検証する手順を定義します。

> **動機**: バックアップが「取られている」ことと「復元できる」ことは別問題。
> 災害復旧 (DR) を頼みの綱にしている以上、検証なしに本番運用するのは危険。
> 「バックアップが壊れていた」事実は障害発生時に初めて判明することが多く、その時点では手遅れ。

---

## 1. 現状のバックアップ機構

### 1.1 Supabase (PostgreSQL データ)

| プラン | 仕組み | 保持期間 | 復旧粒度 |
|---|---|---|---|
| Supabase Free | 自動バックアップ (日次) + 手動 download (要確認) | 7 日 | 日単位 |
| Supabase Pro | Point-in-Time Recovery (PITR) | 7 日 | 1 秒単位 |
| Supabase Team | PITR | 30 日 | 1 秒単位 |

**現状**: MVP 期は Free プラン。バックアップ機構の実用性は **未検証**。

### 1.2 Vercel (アプリコード)

- **コードは GitHub で管理されている** ためバックアップ不要 (origin/main が source of truth)
- Vercel Deployments 履歴: 過去デプロイの即時 Rollback が可能 ([INCIDENT_RESPONSE.md §7.1](./INCIDENT_RESPONSE.md))

### 1.3 Supabase Storage (添付ファイル)

- 現状 Free プラン: 自動バックアップなし
- アップロードされた添付ファイル (ナレッジ画像等) はオブジェクトとして保管されているが、**意図しない削除に対する保護はない**
- 将来検討: S3 のバージョニング相当の設定 / 別 storage への定期コピー

### 1.4 環境変数 / シークレット

- Vercel 環境変数: Vercel Dashboard で管理、エクスポート機能なし
- **手動でローカル `.env.production-backup.encrypted` として 1Password 等のパスワードマネージャに保管推奨**
- 含まれる秘密情報: `NEXTAUTH_SECRET` / `DATABASE_URL` / `ANTHROPIC_API_KEY` / `VOYAGE_API_KEY` / `BREVO_API_KEY` / `CRON_SECRET` 等 ([ENV_VARS.md](./ENV_VARS.md))

---

## 2. 検証スケジュール

### 2.1 定期検証 (四半期)

毎四半期 (1月 / 4月 / 7月 / 10月 の初週) に **全面検証** を実施。
担当: teppei (将来チーム化したら持ち回り)。
所要時間: 約 2-3 時間。

### 2.2 臨時検証

以下の変更後は必ず検証:

- DB スキーマの大規模変更 (新 table / 大 migration 適用)
- Supabase プラン変更 (Free → Pro 等)
- 環境変数の大幅な刷新
- インフラ移行作業前 (AWS 移行検討時 等)

---

## 3. 検証手順

### 3.1 Supabase バックアップからの復元テスト

#### 準備

1. **検証用 Supabase プロジェクトを作成** (本番とは別、無料プランで OK)
2. 検証用 project の `DATABASE_URL` をメモ
3. 本番の最新バックアップを取得:
   - Supabase Dashboard → 本番プロジェクト → Database → Backups
   - 直近のバックアップを **Download** (Free プランで download 可能か要確認、不可なら Pro 期間のみ実施)

#### 復元

```bash
# 検証用プロジェクトの DB に restore
pg_restore \
  --host=<verification-project>.supabase.co \
  --port=5432 \
  --user=postgres \
  --dbname=postgres \
  --no-owner --no-acl \
  /path/to/backup.dump

# または Supabase SQL Editor で復元 (UI)
# Dashboard → Database → Backups → Restore to new project
```

#### 検証項目チェックリスト

復元後、以下を SQL で確認:

```sql
-- テーブル件数の整合性 (本番と乖離していないか)
SELECT 'users' AS tbl, count(*) FROM users WHERE deleted_at IS NULL
UNION ALL
SELECT 'projects', count(*) FROM projects WHERE deleted_at IS NULL
UNION ALL
SELECT 'tenants', count(*) FROM tenants WHERE deleted_at IS NULL
UNION ALL
SELECT 'knowledges', count(*) FROM knowledges WHERE deleted_at IS NULL
UNION ALL
SELECT 'risk_issues', count(*) FROM risk_issues WHERE deleted_at IS NULL
UNION ALL
SELECT 'audit_logs', count(*) FROM audit_logs
UNION ALL
SELECT 'api_call_logs', count(*) FROM api_call_logs;

-- 直近の audit_logs エントリ確認 (時系列の整合性)
SELECT created_at, actor_user_id, entity_type, action
FROM audit_logs
ORDER BY created_at DESC
LIMIT 10;

-- migration 履歴の確認
SELECT migration_name, finished_at, applied_steps_count
FROM _prisma_migrations
ORDER BY finished_at DESC
LIMIT 10;

-- embedding カラムの存在確認 (バックアップ取得タイミング以降の schema 変更が反映されているか)
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'knowledges'
  AND column_name = 'embedding';
```

#### アプリ起動テスト

```bash
# .env.verification を作成 (DATABASE_URL を検証用に差し替え)
cp .env.example .env.verification
# DATABASE_URL を検証用 project のものに編集

# アプリを起動して基本動作確認
DOTENV_CONFIG_PATH=.env.verification pnpm dev

# 確認項目:
# - ログイン (seed user で)
# - プロジェクト一覧表示
# - ナレッジ一覧表示
# - 提案エンジン実行 (任意の検索)
```

### 3.2 Vercel Rollback テスト

[INCIDENT_RESPONSE.md §7.1](./INCIDENT_RESPONSE.md) に従い、**ステージング環境** で実施:

1. ステージング Vercel project の最新 Deployment を確認
2. 1 つ前の Deployment を選択 → **Promote to Production**
3. ロールバック後、サイトが正常表示されるか確認
4. すぐに最新版に戻す (元の Deployment を再度 Promote)

検証項目:
- ロールバックは何秒で完了したか
- ロールバック中にユーザリクエストが 503 にならないか
- 環境変数は前バージョンでも有効か

### 3.3 環境変数の復元可能性検証

1. パスワードマネージャ (1Password 等) から保管済の本番環境変数一覧を取り出す
2. 検証用 Vercel project に手動で全環境変数を投入
3. デプロイして起動 → 主要機能 (認証 / LLM / Email / Stripe Webhook) が動作するか確認

検証項目:
- 全環境変数が保管されているか (新規追加した変数の保管漏れチェック)
- 値の正確性 (改行コード等の混入なし)

### 3.4 Supabase Storage の検証 (添付ファイル)

1. 検証用 Supabase project の Storage に、本番から数件サンプルファイルをアップロード
2. アプリから取得 → 表示確認
3. CDN キャッシュなし状態での読み込み速度確認

---

## 4. 検証結果の記録

各検証実施時、以下を `docs/operations/backup-verifications/YYYY-MM-DD.md` に記録 (ディレクトリは初回作成時に追加):

```markdown
# バックアップ検証 YYYY-MM-DD

- 担当: teppei
- 検証範囲: Supabase / Vercel / Env / Storage
- 所要時間: HH:MM 〜 HH:MM (合計 〇分)

## 結果サマリ

| 項目 | 結果 | 備考 |
|---|---|---|
| Supabase バックアップ復元 | OK / NG | |
| テーブル件数整合性 | OK / NG | 件数差: ... |
| アプリ起動 | OK / NG | |
| Vercel Rollback | OK / NG | 所要時間: 〇秒 |
| 環境変数復元 | OK / NG | 保管漏れ: 〇件 |
| Storage 検証 | OK / NG | |

## 発見した問題

- ...

## Action Items

| # | アクション | 期限 |
|---|---|---|
| 1 | ... | YYYY-MM-DD |

## 次回検証予定

YYYY-MM-DD (四半期後)
```

---

## 5. 検証コストと運用判断

四半期ごとに約 2-3 時間 (検証用 project の準備 + 復元 + 検証 + 記録)。
1 人運用では決して軽い負担ではないが、**「やらないと災害復旧が成立しない」** ため必須項目とする。

### コスト最適化の選択肢

| 選択肢 | コスト | 効果 |
|---|---|---|
| **A. 四半期で完全検証** (現方針) | 2-3 時間 × 4 回/年 | 確実な保護 |
| B. 半年ごとに軽量検証 (テーブル件数のみ) | 30 分 × 2 回/年 | 中程度、復元実証なし |
| C. Supabase Pro へアップグレード + PITR 自動検証 | 月 $25 + 検証手間軽減 | 高い保護、追加費用 |
| D. ユーザ規模拡大時に SRE 専任を雇う | 月 ~$8000 | 完璧、初期は無理 |

**MVP 期は A、Pro 移行を検討する時期に C への移行を判断**。

---

## 6. 復旧不能時のエスカレーション

検証で「復元できない」と判明した場合の対応:

1. **即時に問題の影響範囲を特定** (どのデータが復元できないか)
2. **Supabase Support に問い合わせ** (Pro プランなら 24h 以内応答)
3. **代替バックアップソースの確認**:
   - pg_dump で別途取った snapshot があれば確認
   - Stripe / Voyage / Brevo 等の外部 SaaS の請求・利用履歴から逆算復元
4. **ユーザへの透明な告知** (バックアップ機構の問題は誠実に公表)

---

## 関連ドキュメント

- インシデント対応 (Supabase 全停止時 §6.9): [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md)
- ロールバック手順: [INCIDENT_RESPONSE.md §7](./INCIDENT_RESPONSE.md)
- 環境変数一覧: [ENV_VARS.md](./ENV_VARS.md)
- DB マイグレーション手順: [DB_MIGRATION_PROCEDURE.md](./DB_MIGRATION_PROCEDURE.md)
- インフラ設計: [docs/design/INFRASTRUCTURE.md](../design/INFRASTRUCTURE.md)
- AWS 移行計画: [MIGRATION_TO_AWS.md](./MIGRATION_TO_AWS.md)

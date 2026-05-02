# Vercel デプロイ手順 (Operations)

本ドキュメントは、Vercel への本番デプロイ手順を集約する (OPERATION.md §5)。障害対応は [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md)、ロールバックは [ROLLBACK.md](./ROLLBACK.md) を参照。

---

## 5. Vercel デプロイ手順

### 5.1 `vercel.json` の内容 (ファイル全文)

```json
{
  "installCommand": "pnpm install",
  "buildCommand": "pnpm prisma generate && pnpm build",
  "crons": [
    {
      "path": "/api/health",
      "schedule": "0 0 * * *"
    }
  ]
}
```

- **buildCommand**: Prisma Client 生成 → Next.js ビルドのみ。`prisma migrate deploy` は**含まない** (§3.3 の理由による)
- **crons**: `/api/health` を **毎日 00:00 UTC** にヒット (ウォームアップの保険。5 分間隔のウォームアップは外部 cron-job.org で別設定、詳細は §9)

### 5.2 通常デプロイ (スキーマ変更を含まない場合)

**前提**: Vercel プロジェクトは GitHub リポジトリと接続済み (要確認: Vercel Dashboard で対象プロジェクトの Git 連携設定)。

```bash
# 1. 機能ブランチで作業しコミット
git checkout -b feat/xxx
# ... 編集 ...
git add .
git commit -m "機能追加: xxx"
git push -u origin feat/xxx

# 2. GitHub 上で Pull Request を作成
#    → Vercel が PR ごとに Preview Deployment を自動生成

# 3. PR レビュー・動作確認後、main にマージ
#    → Vercel が main ブランチの Production Deployment を自動生成

# 4. 本番 URL (https://tasukiba.vercel.app) にアクセスし動作確認
```

### 5.3 スキーマ変更を含むデプロイ

手順の **順序が非常に重要**: **マイグレーション適用を先、デプロイを後** にしないと、新コードが旧スキーマのまま起動して `column X does not exist` 等のエラーになる。

#### 推奨手順

```bash
# 1. 機能ブランチで開発 + ローカルマイグレーション作成
git checkout -b feat/xxx
# prisma/schema.prisma を編集
npx prisma migrate dev --name xxx
# ... アプリコード修正 ...
git add .
git commit -m "スキーマ変更: xxx"
git push -u origin feat/xxx

# 2. PR 作成 → レビュー
```

**マージ手順**:

1. **本番 DB にマイグレーションを先に適用** (§3.3 の手順)
   - Supabase ダッシュボード → SQL Editor → `migration.sql` 全文貼付 → Run
   - "Success" を確認
2. マイグレーションが列追加 (ADD COLUMN) かつ `DEFAULT` 指定があるなら、旧コードも**既存のまま動く** (ADD COLUMN は互換性あり)
3. 本番 DB 更新後、**GitHub で PR をマージ** → Vercel が自動デプロイ
4. デプロイ完了後、<https://tasukiba.vercel.app> にアクセスし動作確認

#### 破壊的変更 (DROP / RENAME) の場合

旧コードと新コードがしばらく併存することを考慮し、**2 段デプロイ** を検討:
- PR (a): 新旧両対応のコードをマージ + マイグレーションは後回し
- Supabase で手動マイグレーション適用
- PR (b): 旧列への参照を削除

**要確認**: 本プロジェクトでは現状、破壊的変更の手順例は未定義。初回適用時にユーザメンテナンス時間を取ることを推奨。

---


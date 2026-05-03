# セキュリティ運用 (Operations)

本ドキュメントは、運用上のセキュリティ手順を集約する (OPERATION.md §13)。技術設計は [../design/SECURITY.md](../design/SECURITY.md) を参照。

---

## 13. セキュリティ運用 (PR #122 で追加)

本アプリの多層防御実装の詳細は [`docs/developer/SPECIFICATION.md §25`](../developer/SPECIFICATION.md#25-セキュリティ実装の全体像-多層防御-pr-122-で整理) を参照。本節は **運用担当 (管理者) が日常業務で実施する確認手順** に絞る。

### 13.1 エラー発生状況の確認 (`system_error_logs`)

全エラーは `system_error_logs` テーブルに集約記録される (PR #115)。日次 / 週次で Supabase SQL Editor から以下を実行し、急増・異常を早期検知する:

```sql
-- 過去 24 時間のエラー発生件数 (カテゴリ別)
SELECT category, COUNT(*) AS cnt
FROM system_error_logs
WHERE created_at >= now() - interval '24 hours'
GROUP BY category
ORDER BY cnt DESC;

-- 直近の個別エラー (調査用、message は秘匿情報を含む可能性があるため admin のみアクセス)
SELECT id, category, created_at, LEFT(message, 200) AS message_preview
FROM system_error_logs
ORDER BY created_at DESC
LIMIT 20;
```

**運用ルール**:
- 24 時間で同カテゴリ 50 件超はアラート発火 (将来 Vercel Speed Insights / Sentry 等と連携)
- 機密情報 (メール本文・パスワード等) が message / stack に混入していないかスポットチェック
- 1 ヶ月経過ログは削除 or S3 archive (`cron/cleanup-accounts` と同様の退避バッチ、未実装 — 将来対応)

### 13.2 MFA ロック発生時の対応 (PR #116)

ユーザから「ログインできない」問い合わせがあった場合の分岐フロー:

1. `/admin/users` 画面で対象ユーザを開き、**ログインロック情報** セクションを確認
2. 表示パターンと対応:

| 表示 | 意味 | 対応 |
|---|---|---|
| 「一時ロック: YYYY/MM/DD HH:MM まで」(password ロック) | 5 回連続パスワード失敗で 30 分ロック (PR #85) | 本人に時間経過を案内、急ぎなら「ロック解除」ボタン |
| 「MFA 一時ロック: YYYY/MM/DD HH:MM まで」(MFA ロック) | 3 回連続 TOTP 失敗で 30 分ロック (PR #116) | 本人にリカバリコード使用 or 時間経過を案内、急ぎなら admin が「MFA ロック解除」 |
| 「永続ロック: あり」 | 管理者による無効化 (解除には admin 操作必須) | 解除すべきか判断後、`unlock` API 経由で解除 |

### 13.3 セキュリティ関連環境変数の確認

本番デプロイ前に以下が設定済みであることを確認 (既存 §1 参照):

- `NEXTAUTH_SECRET` — 32 バイトのランダム文字列 (JWT 署名鍵)
- `CRON_SECRET` — cron 認証鍵 (未設定なら cron 機能無効)
- `CI_TRIGGER_PAT` — CI 自動再起動用 PAT (PR #121、[DEVELOPER_GUIDE §9.6](../developer/DEVELOPER_GUIDE.md) 参照、期限管理必須)

### 13.4 インシデント発生時のトリアージ

詳細は [§6 障害対応](#6-障害対応) に準ずるが、**セキュリティインシデント (漏洩疑い)** の場合は追加で:

1. `system_error_logs` を過去 1 週間分取得して message / stack に含まれる **機密情報の種別** を特定
2. 影響範囲: 該当 userId / プロジェクト / 顧客情報を洗い出し
3. 必要に応じて `NEXTAUTH_SECRET` をローテーションして全 JWT を無効化 (強制再ログイン)
4. admin 監査ログ (`audit_logs`) も併せて確認し、異常アクセスパターンを検出

---


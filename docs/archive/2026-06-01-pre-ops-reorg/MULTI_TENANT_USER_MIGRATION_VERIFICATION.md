# Multi-Tenant User Membership 移行検証手順 (ADR-0016)

> **対象 PR**: feat/multi-tenant-user-membership
> **適用日**: 2026-05-20 以降
> **影響範囲**: 全ユーザ (強制ログアウト発生)
> **関連 ADR**: [`docs/adr/0016-multi-tenant-user-membership.md`](../adr/0016-multi-tenant-user-membership.md)

---

## 1. 概要

`User.email` を **グローバル UNIQUE** から **`@@unique([tenantId, email])`** に変更する。
同時に、`tokenVersion` を全 user で increment して既存セッションを失効させる。

### 1.1 主な影響

| 領域 | 旧 | 新 |
|---|---|---|
| email UNIQUE | global | tenant-scoped |
| login UI | email + password | **組織 ID** + email + password |
| pre-auth API (lock-status / password-reset) | email | email + tenantSlug |
| session | tokenVersion 据置 | **increment で強制 logout** |

### 1.2 強制 logout の理由

セッション中の JWT は旧 schema 想定の `(global email) → userId` 解決を内部で持つ可能性があるため、
schema 切替直後に全 session を破棄する (= 再ログインで multi-tenant 経路に乗せる)。

---

## 2. 事前検証 (= 重複ユーザの有無)

### 2.1 重複 email チェック (= 同 email が複数 tenant に存在しないか)

```sql
-- ADR-0016 移行前に実行: 同一 email が複数 tenant に居れば listing される
SELECT email, COUNT(DISTINCT tenant_id) AS tenants
FROM users
WHERE deleted_at IS NULL
GROUP BY email
HAVING COUNT(DISTINCT tenant_id) > 1;
```

**期待値**: 0 件 (重複なし = 移行可能)
**1 件以上ヒットした場合**: 該当ユーザの所属テナントを確定させてから移行する
  (= 旧 global email UNIQUE 環境では本来発生不能なので、Phase 1 のバグで作られた可能性あり)。

### 2.2 削除済 vs 有効 email 衝突チェック

```sql
-- ADR-0016: 同 email で deleted/active が混在していないか確認
SELECT email, COUNT(*) FILTER (WHERE deleted_at IS NULL) AS active,
                       COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted
FROM users
GROUP BY email
HAVING COUNT(*) FILTER (WHERE deleted_at IS NULL) > 0
   AND COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) > 0;
```

**期待値**: 0 件、または `tenantId` 違いなら問題なし (= 新 schema で共存可能)。

### 2.3 production / staging DB 状態 (2026-05-20 検証時点)

| 環境 | 重複 email | tenant 数 | user 数 | 削除/有効衝突 |
|---|---|---|---|---|
| production | 0 | 2 (MANAGEMENT + Default) | 7 | 0 |
| staging | 0 | 2 | 7 | 0 |

→ **移行可** (検証済)。

---

## 3. 移行手順

### 3.1 マイグレーション本体

```bash
# 1. Netlify deploy 経由で自動適用 (推奨)
git push origin main  # → Netlify build で `prisma migrate deploy` 自動実行

# 2. 手動緊急実行 (Netlify build が失敗した場合)
psql "$DIRECT_URL" -f prisma/migrations/20260520_users_email_tenant_scoped_unique/migration.sql
```

### 3.2 移行内容 (migration.sql)

1. `DROP INDEX idx_users_email` (= 旧 global unique)
2. `CREATE UNIQUE INDEX idx_users_tenant_email ON users(tenant_id, email)` (= 新 tenant-scoped unique)
3. `UPDATE users SET token_version = token_version + 1` (= 強制 logout 全 user)

> ⚠️ Step 3 (token_version increment) は **全ユーザを強制 logout** する。
> リリースアナウンス・障害連絡網への通知を併用すること。

### 3.3 ロールバック (緊急時のみ)

```bash
psql "$DIRECT_URL" -f prisma/migrations/20260520_users_email_tenant_scoped_unique/rollback.sql
```

**注意**: rollback 後は schema.prisma を旧 `@@unique([email])` に戻して redeploy が必要。
復旧時間: 5〜10 分。

---

## 4. 事後検証 (= デプロイ後の動作確認)

### 4.1 schema 反映確認

```sql
-- 新 index が存在することを確認
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'users';
-- → idx_users_tenant_email が含まれていれば OK
-- → idx_users_email は無いこと (= 旧 index drop 済)
```

### 4.2 ログイン動作確認 (smoke test)

| 経路 | 検証手順 | 期待結果 |
|---|---|---|
| Login | `/login` で 組織 ID + email + password 入力 | dashboard 遷移 |
| 招待リンク | super_admin が user 招待 → メール内リンクで setup-password | パスワード設定可 |
| パスワードリセット | `/reset-password` で 組織 ID + email + recoveryCode | 新パスワード設定可 |
| lock-status | `/api/auth/lock-status` に tenantSlug 含めて POST | 適切な lock 状態返却 |
| 不正 tenantSlug | 存在しない slug を送信 | `{status: 'none'}` (enumeration 防止) |

### 4.3 強制 logout 確認

```sql
-- 移行直前の token_version を控えておき、移行後に +1 されていることを確認
SELECT id, email, token_version FROM users WHERE deleted_at IS NULL LIMIT 5;
```

---

## 5. 既知の注意事項

### 5.1 メールリンクの後方互換

**旧形式** (= 移行前に送信済みリンク):

- `/setup-password?token=XXX` (組織 ID 無し)
- `/reset-password?token=XXX`

→ 移行後は URL に `?tenant=<slug>` クエリが付与されないと、UI 側の組織 ID 欄が空になる。
   ユーザは手動で組織 ID を入力する必要がある (移行前送信分に限る、新規送信分は自動付与される)。

**対応**: 移行直前 24 時間に送信した招待/リセットメールがあれば、再送するか、
   ユーザに「組織 ID を入力してから操作してください」と案内する。

### 5.2 NextAuth セッション cookie

`tokenVersion` increment で `layout DB 照合` が失敗 → middleware が自動 logout する。
[`feedback_session_clearance_pattern.md`](../../.claude/memory ...) (KDD §5.X+72) のパターンに沿った設計のため、
Netlify Set-Cookie 脱落事故にも耐性がある。

### 5.3 Visual Regression Test の Baseline

`e2e/visual/auth-screens.spec.ts` の baseline は **必ず再生成が必要**:

```bash
# Netlify 環境ではなく `.github/workflows/e2e-visual-baseline.yml` の
# workflow_dispatch をトリガすること (Windows/macOS local では再生成しない)。
```

理由: login / reset-password ページに 組織 ID 入力欄が追加されたため、
   旧 baseline PNG とは構造的に差分が発生する。

---

## 6. リリースタイミング

- **推奨**: 利用者が少ない深夜帯 (= 強制 logout の影響を最小化)
- **アナウンス**: 24h 前にユーザへ「メンテナンスのお知らせ」を送信
   ("一度ログアウトされるため、再度組織 ID + メール + パスワードでログインしてください")
- **rollback タイムリミット**: 適用後 2 時間以内 (= ロールバックすると新 path 経由で
   登録されたデータが整合性破壊する可能性あり)

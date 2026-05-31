# 運用保守業務カタログ (Maintenance Operations Catalog)

本ドキュメントは、本サービスの **super_admin (運営担当)** が日々実施する運用保守業務の全体像を **定常業務 / アドホック業務** の 2 軸で一覧化する。詳細手順は各専用 doc にリンクし、専用 doc が未整備の業務は本ドキュメントに直接手順を記述する。

## 想定読者と前提

- **読者**: super_admin (本サービス運営担当 1〜2 名)
- **想定スケール**: 顧客テナント数 数件〜10 件未満 (MVP フェーズ)
- **必要権限**: super_admin (`/admin/super` 配下の全機能アクセス可) + Supabase SQL Editor 直接アクセス + Netlify Dashboard アクセス + 運営用メールアカウント
- **本 doc の位置付け**: 索引 + 専用 doc が無い手順の格納場所

---

## §1. 定常業務 (Routine)

事前にスケジュール可能な、頻度が決まっている業務。**実施を忘れると運用品質が落ちる**ため、カレンダー / Reminder 化を推奨。

### §1.1 日次

| 業務 | 内容 | 想定所要 | 詳細 |
|---|---|---|---|
| Cron 死活監視 | `cron_execution_logs` に前 24h 分のレコードが揃っているかをダッシュボードで確認。失敗 (`status='failure'`) があれば即調査 | 5 分 | [CRON.md](./CRON.md) §死活監視 |
| Netlify Functions ログのエラー流量確認 | 直近 24h の `level=error` の有無を流し見。新規エラー型は調査 | 5 分 | [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md) §0 |
| 顧客フィードバック トリアージ (新規受付) | 6 チャネル受信箱を巡回し、GitHub Issues に集約 | 10 分 | [CUSTOMER_FEEDBACK_TRIAGE.md](./CUSTOMER_FEEDBACK_TRIAGE.md) §日次 |

### §1.2 週次

| 業務 | 内容 | 想定所要 | 詳細 |
|---|---|---|---|
| 顧客フィードバック 週次集計 | P0/P1 滞留チェック + 重要度再評価 | 30 分 | [CUSTOMER_FEEDBACK_TRIAGE.md](./CUSTOMER_FEEDBACK_TRIAGE.md) §週次 |
| 依存パッケージ脆弱性チェック | Dependabot / `pnpm audit` の結果確認 + 重要度別 SLA 判定 | 15 分 | [DEPENDENCY_VULNERABILITY_PROCESS.md](./DEPENDENCY_VULNERABILITY_PROCESS.md) |

### §1.3 月次

| 業務 | 実施タイミング | 内容 | 詳細 |
|---|---|---|---|
| 月次請求業務 | 月初 (前月集計確定後) | 全テナントの利用量集計 → CSV エクスポート → 請求書発行 (`invoice` テナント) / Stripe 自動消込確認 (`credit_card` テナント) | [BILLING_MONTHLY_OPERATIONS.md](./BILLING_MONTHLY_OPERATIONS.md) |
| 銀行入金消込 (invoice テナント限定) | 翌月 16〜25日 隔日〜毎日 | 銀行口座を確認し、入金消込シートを更新 | [PAYMENT_DELINQUENCY_SOP.md](./PAYMENT_DELINQUENCY_SOP.md) §0 |
| 滞納テナント検知 (invoice テナント限定) | 翌月 26日朝 (★ 月 1 回必須) | 25日支払期限到来後の未入金リスト確認 → 滞納フロー開始 | [PAYMENT_DELINQUENCY_SOP.md](./PAYMENT_DELINQUENCY_SOP.md) §0 / §1 |
| 顧客フィードバック 月次集計 | 月初 | カテゴリ別件数集計、傾向分析、ロードマップ反映判断 | [CUSTOMER_FEEDBACK_TRIAGE.md](./CUSTOMER_FEEDBACK_TRIAGE.md) §月次 |

### §1.4 四半期

| 業務 | 内容 | 詳細 |
|---|---|---|
| バックアップ検証 | Supabase / Netlify / Storage / 環境変数の **復元可能性** を実機検証 | [BACKUP_VERIFICATION.md](./BACKUP_VERIFICATION.md) |
| セキュリティ再評価 | OWASP Top 10 観点で実装状況をスナップショット更新 + 残課題優先度見直し | [SECURITY_ASSESSMENT.md](./SECURITY_ASSESSMENT.md) |
| Dogfooding (自社内利用検証) | AI 補助なしで機能実装を試し、ドキュメント網羅性を検証 | [DOGFOODING_PLAN.md](../DOGFOODING_PLAN.md) |

### §1.5 年次 (または半年)

| 業務 | 内容 | 詳細 |
|---|---|---|
| ペネトレーションテスト | 外部業者によるセキュリティ侵入試験 | [SECURITY_ASSESSMENT.md](./SECURITY_ASSESSMENT.md) §ペネトレーションテスト |
| 法的書類見直し | 利用規約 / プライバシーポリシー / 特定商取引法表示の改訂要否確認 | [PUBLIC_LAUNCH_CHECKLIST.md](../../archive/2026-06-01-pre-ops-reorg/PUBLIC_LAUNCH_CHECKLIST.md) |
| **`CI_TRIGGER_PAT` ローテーション (期限管理必須)** | **期限: 2027-04-24 失効**。期限 **30 日前を目安** に fine-grained PAT を再発行 (`repo: BusinessManagementPlatform` only / `Contents: Read and write` / 1 年期限) → GitHub Repo Settings → Secrets の `CI_TRIGGER_PAT` を上書き。失効しても fallback で `GITHUB_TOKEN` に戻り壊れはしないが、baseline auto-commit 後の **CI 自動再起動が効かなくなる**。次回失効日を更新時に本行へ反映すること | §1.5.1 (本ドキュメント内) |

#### §1.5.1 `CI_TRIGGER_PAT` ローテーション手順 (期限: 2027-04-24)

`[gen-visual]` 等の baseline auto-commit 後に CI を自動再起動するために使う fine-grained PAT。失効すると CI が `GITHUB_TOKEN` に fallback し、auto-commit 後の **ワークフロー自動再トリガが効かなくなる** (ビルド自体は壊れない)。

- **対象 Secret**: GitHub Repo Settings → Secrets and variables → Actions → `CI_TRIGGER_PAT`
- **現行失効日**: 2027-04-24 (更新都度この日付を本行・上表に反映する)
- **更新タイミング**: 失効 30 日前を目安にリマインドして再発行
- **更新手順**:
  1. GitHub → Settings → Developer settings → Fine-grained tokens で新規 PAT を発行
     - リポジトリ: `BusinessManagementPlatform` のみ
     - 権限: `Contents: Read and write`
     - 有効期限: 1 年
  2. Repo Settings → Secrets の `CI_TRIGGER_PAT` を新しい値で上書き
  3. 次回の baseline 更新 (`[gen-visual]` commit 等) で CI 自動再起動が動作することを確認

---

## §2. アドホック業務 (Ad-hoc)

事前にスケジュールできず、**特定のトリガ発生時に都度実施**する業務。**発生条件と重大度**を一覧化し、迷わず手順 doc に到達できるようにする。

### §2.1 トリガ別一覧

| トリガ | 業務名 | 重大度 | 想定対応時間 | 詳細 |
|---|---|---|---|---|
| 本番障害発生 (500 連発 / 機能停止 / データ破損) | 障害対応とロールバック | S-1 〜 S-3 | 30 分〜 (初動目標) | [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md) |
| 月 26日朝に未入金検知 | 滞納フロー (リマインダー → 内容証明 → 削除) | S-2 | 1〜2 ヶ月 (法的手続込) | [PAYMENT_DELINQUENCY_SOP.md](./PAYMENT_DELINQUENCY_SOP.md) §1〜 |
| データ消失 / 破損 検知 | バックアップからのリストア | S-1 | 1〜4 時間 | [BACKUP_VERIFICATION.md](./BACKUP_VERIFICATION.md) §復元手順 |
| 重大脆弱性検出 (CVSS 9.0+) | 依存パッケージ緊急更新 | S-1 〜 S-2 | 24 時間以内 | [DEPENDENCY_VULNERABILITY_PROCESS.md](./DEPENDENCY_VULNERABILITY_PROCESS.md) §重要度別 SLA |
| 不正利用 / 規約違反テナント検知 | read-only モード手動移行 (suspend) | S-2 | 即時 | [PAYMENT_DELINQUENCY_SOP.md](./PAYMENT_DELINQUENCY_SOP.md) §read-only 移行 / `/admin/super/tenants/<id>` UI |
| セキュリティインシデント疑い (漏洩 / 不正アクセス) | セキュリティインシデント対応 | S-1 | 30 分以内に初動 | [SECURITY_OPS.md](./SECURITY_OPS.md) + [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md) §6.10 |
| リリース実施 (バージョン更新) | リリース手順 | (計画的) | 1〜2 時間 | [RELEASE_PROCEDURE.md](../develop/RELEASE_PROCEDURE.md) / [GO_LIVE_RUNBOOK.md](../../archive/2026-06-01-pre-ops-reorg/GO_LIVE_RUNBOOK.md) |
| **★ MFA 設定情報が画面から修復不能** (= 利用者が「コードが正しくありません」で詰む / Function ログに `bad decrypt` エラー) | **MFA 設定情報の DB 直接削除 → 利用者に再 setup を依頼** | S-2 | 15 分 | **§2.2 (本ドキュメント内)** |

### §2.2 MFA 設定情報の DB 直接削除手順 (2026-05-25 追加)

#### 発生条件

利用者から「MFA ログインで `コードが正しくありません` と表示されてダッシュボードに入れない」という報告を受け、かつ Netlify Function ログに以下のエラーが記録されている場合:

```
ERROR ⨯ Error: error:1C800064:Provider routines::bad decrypt
library: 'Provider routines',
reason: 'bad decrypt',
code: 'ERR_OSSL_BAD_DECRYPT'
```

これは [src/services/mfa.service.ts:34-41](../../../src/services/mfa.service.ts#L34-L41) の `decrypt(mfaSecretEncrypted)` で発生する OpenSSL の AES 復号失敗で、**MFA セットアップ時に使われた暗号化鍵と、現在の暗号化鍵 (`NEXTAUTH_SECRET` の先頭 32 文字) が異なっている**ことが原因。発生シナリオ:

1. **★ 最頻★ `NEXTAUTH_SECRET` のローテーション / 編集**: Netlify 環境変数で値を変更すると、過去に暗号化された `mfaSecretEncrypted` は復号不能になる ([ENV_VARS.md §1.3](../ENV_VARS.md))
2. **DB 復元 / 環境間コピー**: 別環境の dump を流し込んだ等で、暗号化時と異なる secret 環境にデータが移動した
3. **`NEXTAUTH_SECRET` の typo 修正**: 値の編集自体が rotation と等価のため、結果として復号不能になる

#### この手順で対象外のケース

以下の場合は本手順を使わない:

- 利用者が単純に TOTP コードを誤入力している (= ログに `bad decrypt` が**出ていない**、ログには 400 `VALIDATION_ERROR` が記録される)
- 利用者の MFA ロックアウト (= `mfa_locked_until` が未来) → 30 分待つか `unlockMfaByAdmin` API を使う
- 利用者が super_admin で、UI 上 MFA 無効化禁止仕様により詰んでいる場合 (= 同じく本手順だが「super_admin 本人」セクションを参照)

#### 想定読者と認可

- **実施者**: super_admin (システム管理者)
- **対象**: テナント管理者 (admin) / 一般ユーザ (general) / super_admin 本人 (= 自分自身)
- **テナント管理者 (admin) / 一般ユーザ (general) からの依頼**: 本人確認 (= 登録メール経由の連絡、社内の別経路での身元確認) を実施した後に作業
- **super_admin 本人**: 単独で実施可能 (= 本人確認の必要なし)

#### 事前準備

- Supabase Dashboard → SQL Editor を開いておく
- 利用者から以下を聞き取り:
  - 登録メールアドレス
  - テナントの `slug` (= URL の `/t/<slug>` 部分、または利用者の所属テナント名)
- 本作業の **タイムスタンプを運用ノート / Notion 等にメモ開始**

#### 手順

##### STEP 1: 対象ユーザの特定 (実行前の確認)

> **必ず先に SELECT で対象を 1 行に絞れることを確認する。** `UPDATE` の `WHERE` を間違えると別ユーザの MFA を消す事故になる。

```sql
-- パターン A: email + テナント slug で特定 (推奨、ADR-0016 multi-tenant 対応)
SELECT u.id, u.email, u.system_role, u.is_active, u.deleted_at,
       u.mfa_enabled, u.mfa_enabled_at,
       length(u.mfa_secret_encrypted) AS mfa_secret_len,
       u.mfa_failed_count, u.mfa_locked_until,
       t.slug AS tenant_slug, t.id AS tenant_id
FROM users u
JOIN tenants t ON t.id = u.tenant_id
WHERE u.email = '<対象メール>'
  AND t.slug = '<対象テナント slug>'
  AND u.deleted_at IS NULL;
```

```sql
-- パターン B: email のみ (シングルテナント運用中なら可、複数ヒットに注意)
SELECT id, email, system_role, mfa_enabled, mfa_enabled_at,
       length(mfa_secret_encrypted) AS mfa_secret_len,
       mfa_failed_count, mfa_locked_until, tenant_id
FROM users
WHERE email = '<対象メール>'
  AND deleted_at IS NULL;
```

**確認チェックリスト**:

- [ ] 該当ユーザが **1 行だけ** 返ること
- [ ] `mfa_enabled = true` であること (= 本当に MFA 状態を持っているか、無効ならそもそも本手順は不要)
- [ ] `mfa_secret_len` が 例えば 60〜100 文字程度の値であること (= 暗号化済みデータが存在する)
- [ ] `system_role` (`super_admin` / `admin` / `general`) を控えておく (= 運用ノート用)
- [ ] `id` を次の `UPDATE` でコピペするため控える

##### STEP 2: MFA 設定情報の削除 (= 無効化状態に戻す)

`BEGIN; ... COMMIT;` でトランザクション化することを **強く推奨** (誤実行時に `ROLLBACK;` で取り消せる):

```sql
BEGIN;

UPDATE users
SET mfa_enabled        = false,
    mfa_secret_encrypted = NULL,
    mfa_enabled_at     = NULL,
    mfa_failed_count   = 0,
    mfa_locked_until   = NULL,
    -- 防御深度: 他デバイスのセッションも全て失効させる
    -- (= 仮に攻撃者が別 session を持っていた場合の遮断)
    token_version      = token_version + 1,
    updated_at         = now()
WHERE id = '<STEP 1 で取得した id>'
  AND deleted_at IS NULL;

-- Supabase SQL Editor は UPDATE の影響行数を結果欄に表示する。
-- 1 が返ることを必ず確認 (0 や 2+ なら ROLLBACK; して STEP 1 から見直す)

COMMIT;
```

> **`ROLLBACK;`**: `COMMIT;` する前に「あ、間違えた」と気付いたら `COMMIT;` の代わりに `ROLLBACK;` を実行することで変更を取り消せる。`COMMIT;` 後は復元手段は別バックアップからのリストアのみになるため、慎重に。

##### STEP 3: 実行後の検証

```sql
SELECT id, email, system_role, mfa_enabled, mfa_enabled_at,
       mfa_secret_encrypted, mfa_failed_count, mfa_locked_until,
       token_version, updated_at
FROM users
WHERE id = '<STEP 1 で取得した id>';
```

**期待値**:

- `mfa_enabled` = `false`
- `mfa_secret_encrypted` = `NULL`
- `mfa_enabled_at` = `NULL`
- `mfa_failed_count` = `0`
- `mfa_locked_until` = `NULL`
- `token_version` が `+1` されている
- `updated_at` が直近のタイムスタンプ

##### STEP 4: 利用者への連絡 + 復旧確認

1. 利用者に以下を案内:
   - 「MFA 設定をリセットしました。一度ログアウトして、再度ログインしてください。」
   - 「再ログイン後、設定画面 (アカウントメニュー → 設定) から MFA を再 setup してください。」
   - 「**再 setup までは MFA 無し**でログイン可能な状態なので、その間はパスワード管理に十分注意してください。」
2. 利用者から「再 setup 完了」報告を受け、`SELECT` で `mfa_enabled = true` + `mfa_enabled_at IS NOT NULL` を再確認
3. 完了タイムスタンプを運用ノートに記録 (§3 参照)

#### ⚠ 触らない方が良いテーブル

##### `recovery_codes` テーブルは **そのまま残す** ことを推奨

- recovery code は **bcrypt ハッシュ** で保存されており、AES 暗号化 (= `NEXTAUTH_SECRET` 依存) **ではない**
- → 今回の bad decrypt 事故で **recovery code は壊れていない**
- 利用者が初回 setup 時に控えた recovery code はそのまま使い続けられる (= 安全網として残す)
- 削除すると、次に同じ事故に遭った時に詰む

ただし、漏洩懸念があり「念のため全失効させたい」場合のみ実行する SQL:

```sql
-- 全 recovery code を失効 (= 使用済みフラグを立てて再使用不能化)
UPDATE recovery_codes
SET used_at = now()
WHERE user_id = '<STEP 1 で取得した id>'
  AND used_at IS NULL;
```

> この場合、利用者は MFA 再 setup 完了後も recovery code が 0 個の状態になる。現状の MFA enable route ([src/app/api/auth/mfa/enable/route.ts](../../../src/app/api/auth/mfa/enable/route.ts)) は recovery code を再生成しない仕様のため、別途 `POST /api/admin/users/[userId]/recovery-codes` ([src/app/api/admin/users/[userId]/recovery-codes/route.ts](../../../src/app/api/admin/users/[userId]/recovery-codes/route.ts)) を別の admin が叩いて再発行する必要がある。

#### ⚠ super_admin (システム管理者本人) を対象にする場合の追加注意

[src/services/mfa.service.ts:172-180](../../../src/services/mfa.service.ts#L172-L180) により super_admin は UI からの MFA 無効化が禁止されている (= MFA 必須 invariant)。一方で本 SQL を super_admin に実行すると、**一時的に super_admin の MFA が OFF** になる。

**手順厳守**:

1. SQL 実行
2. **同じセッション (= ブラウザ) でログアウト**
3. **すぐ再ログイン** (MFA 画面は出ない)
4. **その場で必ず設定画面から MFA を再 setup**
5. 再 setup 完了まで席を離れない / 別タブで業務を始めない

放置すると super_admin が MFA OFF のまま残り、`mfaEnabled=true` 強制という invariant が破れた状態でプラットフォームが運用されてしまう。

#### 関連事象: NEXTAUTH_SECRET ローテーション時の予防策

本事故は `NEXTAUTH_SECRET` の変更が引き金になることが最頻なので、**ローテーション時には全 MFA ユーザの再 setup が必要**になる。手順:

1. ローテーション前に MFA 有効ユーザを一覧化:
   ```sql
   SELECT id, email, system_role, mfa_enabled_at
   FROM users
   WHERE mfa_enabled = true AND deleted_at IS NULL
   ORDER BY mfa_enabled_at;
   ```
2. 対象ユーザに事前告知 (= 「MFA 再 setup が必要になる」)
3. `NEXTAUTH_SECRET` を変更 (Netlify Dashboard → Environment variables)
4. デプロイ完了後、対象ユーザに対して本 §2.2 の手順を実施 (= `mfa_secret_encrypted` を全件 NULL 化)
5. 各ユーザに再 setup を依頼

詳細: [ENV_VARS.md §1.3](../ENV_VARS.md) の `NEXTAUTH_SECRET` ローテーション注意書きも参照。

#### 過去事例

| 発生日 | 影響範囲 | 原因 | 対応所要 |
|---|---|---|---|
| 2026-05-25 | super_admin 1 名 (= 運営担当) | `NEXTAUTH_SECRET` ローテーション時に MFA 再 setup 失念 | 約 30 分 (調査含む) |

---

## §3. 業務記録と監査ルール

DB 直接操作は `audit_logs` / `auth_event_logs` に **自動記録されない**。super_admin の権限行使は事後の説明責任を果たせるよう、運用ノートを必ず残す。

### §3.1 必ず記録する項目

| 項目 | 例 |
|---|---|
| 実施日時 | `2026-05-25 14:30 JST` |
| 実施者 | `teppei09141998@gmail.com` (super_admin) |
| 対象ユーザ / テナント | user.id / email / systemRole / tenant.slug |
| トリガ | 「利用者から MFA ログイン詰みの連絡 (Netlify ログで bad decrypt 確認)」等 |
| 実行 SQL | `UPDATE users SET ...` (実行したクエリそのまま) |
| 影響行数 | `1 row` |
| 検証結果 | STEP 3 SELECT の出力 |
| 復旧確認 | 「利用者から再 setup 完了報告受領 (YYYY-MM-DD HH:MM)」 |

### §3.2 記録の保管場所

- 短期 (1〜2 週): 運用ノート / Notion / Google Docs
- 長期 (1 年以上): 重大度 S-1 / S-2 はインシデント post-mortem として `docs/operations/` 配下に専用ファイルを作成 ([INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md) §post-mortem 参照)

### §3.3 ★ レビュー可能性の維持

将来 super_admin が複数人体制になった時に「誰がいつ何をやったか」を相互レビューできるよう、運用ノートは原則 **共有可能な場所**に置く (= 個人 PC 内のテキストファイルのみは避ける)。

---

## §4. 関連ドキュメント

| カテゴリ | doc |
|---|---|
| デプロイ全般 | [DEPLOYMENT.md](../develop/DEPLOYMENT.md) |
| 環境変数 | [ENV_VARS.md](../ENV_VARS.md) |
| DB マイグレーション | [DB_MIGRATION_PROCEDURE.md](../develop/DB_MIGRATION_PROCEDURE.md) |
| 障害対応全般 | [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md) |
| Cron 運用 | [CRON.md](./CRON.md) |
| セキュリティ運用 | [SECURITY_OPS.md](./SECURITY_OPS.md) / [SECURITY_ASSESSMENT.md](./SECURITY_ASSESSMENT.md) |

---

## §5. 改訂履歴

| 日付 | 改訂内容 | PR |
|---|---|---|
| 2026-05-25 | 新規作成。定常業務 §1 / アドホック業務 §2 / MFA 設定情報 DB 直接削除手順 §2.2 を記載 | (本 PR) |

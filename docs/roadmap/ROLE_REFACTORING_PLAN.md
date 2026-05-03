# ロール再構築計画 — テナント管理者 + システム管理者の二層化

本ドキュメントは、現状の単層 `admin` ロールを **テナント管理者 + システム管理者** の二層構造に再構築する計画を定義する。マルチテナント基盤 (PR #2-a〜PR #5-c) 完了に伴い、運営側 (運営者) の監視責務とテナント内の管理責務を明示的に分離するための変更。

**着手タイミング**: PR #6/#7/#8 (T-03 リリース準備) 完了後。**6/1 リリースまでに完了目標 (必達ではない)**。

関連: [SUGGESTION_ENGINE_PLAN.md](./SUGGESTION_ENGINE_PLAN.md) / [../business/USER_ROLES.md](../business/USER_ROLES.md) / [../specification/PERMISSION_MATRIX.md](../specification/PERMISSION_MATRIX.md)

---

## 1. 背景と目的

### 1.1 背景

PR #2-a (マルチテナント基盤) 〜 PR #5-c (Knowledge / RiskIssue / Retrospective embedding 生成フック) でマルチテナント環境が整い、各テナントが独立して運営される基盤が完成した。一方で、**運営側 (本サービス運営者) が全テナントを横断的に監視する責務** (API 利用量・DB 容量・異常検知) はまだ役割として明示されていない。

現状の単層 `User.systemRole = 'admin' | 'general'` モデルでは、`admin` が「全 entity を見られる強権限」として機能しており、本来「**自テナント内の全権限を持つ管理者**」と「**全テナントを監視する運営者**」が混在している。

### 1.2 目的

- **テナント管理者 (admin)** と **システム管理者 (super_admin)** を明示的に分離
- 運営者 (= teppei さん) のみが super_admin として全テナント監視可能
- 各テナント内の管理権限は admin (テナント管理者) として独立して機能
- 監視機能 (テナント別 API 利用量 / DB 容量) を super_admin 専用として実装

### 1.3 ゴール

- super_admin による全テナント API 利用量・DB 容量の監視ダッシュボード
- 既存 `admin` の意味を「テナント管理者」として再解釈、コード変更を最小化
- 6/1 リリース時に正しいロール名で運用開始 (UI 文言・ドキュメント整合)

---

## 2. 設計決定事項 (議論履歴含む)

### 2.1 ロール体系 (Q1 決定)

選択肢 C-1 を採用:

| 役割 | DB 値 (`systemRole`) | 説明 |
|---|---|---|
| 一般ユーザ | `'general'` (既存) | プロジェクト/役割に応じた権限のみ |
| テナント管理者 | `'admin'` (既存、**意味再解釈**) | 自テナント内の全権限。多くの既存 `=== 'admin'` チェックは引き続きこの意味で動作 |
| システム管理者 | `'super_admin'` (**新規**) | 運営者専用。全テナント監視 + 自分の所属テナント内では admin 相当 |

**選定理由**:
- 既存 36 箇所の `systemRole === 'admin'` チェックを置換せず再利用可能
- 既存テストの `'admin'` 値は「テナント管理者」を意味するためテスト変更不要
- DB マイグレーションは VarChar(20) のまま許容値追加のみで完結

**却下した代替案**:
- 案 A (`'general'` / `'tenant_admin'` / `'system_admin'` の完全リネーム) — 144 箇所のリテラル全置換が必要、リスクが高い
- 案 B (`isSuperAdmin: boolean` の追加フィールド) — 役割の階層が暗黙的になり把握しづらい

### 2.2 階層関係 (Q2 決定)

```
super_admin (運営者専用、teppei さんのみ)
   ├─ 全テナントの監視・管理 (横断機能)
   └─ 自分の所属テナント (= 管理テナント) 内では admin と同等の権限

admin (= テナント管理者、各テナントごとに存在)
   └─ 自分の所属テナント内で全権限

general (= 一般ユーザ、各テナントごとに存在)
   └─ プロジェクト/役割に応じた権限
```

**重要な点**:
- super_admin は**全テナントで 1 人** (Phase 1 では teppei さんのみ)
- super_admin user 自身は「管理テナント」というテナントに所属する
- 管理テナント内では admin と同等の操作が可能
- 他テナントに対しては監視 + 管理機能が使える (entity 編集はしない)

### 2.3 管理テナント (Q3 決定)

専用の管理テナントを新規作成する (案 1):

| 項目 | 設定 |
|---|---|
| Tenant UUID | `00000000-0000-0000-0000-FFFFFFFFFFFF` (default-tenant の `00000000-0000-0000-0000-000000000001` と区別) |
| Tenant 名 (`Tenant.name`) | **`'Knowledge Relay Platform'`** |
| プラン (`Tenant.plan`) | 特殊扱い (課金対象外、無制限)。実装上は `'pro'` 相当 + `monthlyApiCallCap = null` で運用 |
| 説明 | 運営側の管理用テナント。ユーザ拡大しても super_admin 1〜数名のみ所属 |

### 2.4 super_admin アカウント運用 (案 2 採用)

> 元の Q3 では「`teppei09141998@gmail.com` を管理テナントへ移籍」が当初推奨だったが、追加検討の結果、**案 2 (別 email で新規 super_admin を作成、既存アカウントは元テナントに残す)** に変更。

**変更理由**:
- 本番運用 (super_admin) と開発・試験操作 (元テナント admin) を**メール単位で明確分離**
- 万一 super_admin アカウントが侵害されても影響を限定 (セキュリティベストプラクティス)
- 元テナントでこれまでに蓄積したデータ・権限を失わずに済む
- メール送受信が運用上不要なため、専用ドメインメールでも問題ない

**確定した運用**:

| 項目 | 設定 |
|---|---|
| 既存 `teppei09141998@gmail.com` | 既存テナントに残す (admin 権限維持、開発・試験用途) |
| 新規 super_admin email | 別途確定 (例: `admin@knowledge-relay.local` 等、seed 時に environment 変数経由で指定) |
| 所属テナント | 管理テナント (上記 2.3) |
| `User.systemRole` | `'super_admin'` |

### 2.5 パスワード設定方法 (Q3 案 a)

| 項目 | 設定 |
|---|---|
| 環境変数 | `SUPER_ADMIN_INITIAL_PASSWORD` (Vercel に登録) |
| 環境変数 | `SUPER_ADMIN_INITIAL_EMAIL` (新 email を別環境変数で指定) |
| 環境変数 | `SUPER_ADMIN_INITIAL_NAME` (表示名) |
| 登録方法 | seed migration が `bcrypt` 化して User に格納 |
| 初回ログイン | `forcePasswordChange = true` セット → 強制変更画面に誘導 |

### 2.6 機能スコープ (Q4 決定)

**Phase 1 (必須、6/1 リリース目標)**:
- ✅ 全テナント一覧 (テナント名 / プラン / 月次 API 呼び出し数 / 月次費用 / アクティブユーザ数 / 作成日)
- ✅ テナントごとの DB 容量モニタ (entity 数 / embedding 行数)
- ✅ テナントごとの月次推移グラフ
- ✅ 全テナント横断使用量サマリ (Voyage 200M 残量 / Anthropic 月次費用 / Supabase DB 容量)

**Phase 2 (オプション、リリース後検討)**:
- 🟡 テナントのプラン強制変更 (ダウングレード / サスペンド)
- 🟡 テナント管理者の代理操作 (impersonate)
- 🟡 全テナント横断の entity 検索 (監査用途)

**将来検討 (Phase 3+)**:
- 🟢 個別 entity の編集権限 (現状不要、監視のみで十分)

### 2.7 タイミング (Q5 決定)

```
[現在 2026-05-03 以降]
   ↓
PR #6: 初期シードデータ (3-4 日)
   ↓
PR #7: 監視と異常検知 (3-4 日)
   ↓
PR #8: 統合テスト + リリース準備 (4-5 日)
   ↓
========== ここまで T-03 残作業で 約 11-13 日 ==========
   ↓
PR-X1: ロール schema 拡張 + 管理テナント作成 + 認可ヘルパ追加 (1-2 日)
   ↓
PR-X2: super_admin 向けダッシュボード (Phase 1 機能) (2-3 日)
   ↓
PR-X3: UI 文言更新 + ドキュメント更新 (1 日)
   ↓
========== ロール refactoring 約 4-6 日 ==========
   ↓
[6/1 リリース]
   ↓
リリース後: Phase 2 機能 (プラン強制変更 / impersonate / 監査検索)
```

合計 15-19 日の作業見込み。**6/1 まで残約 29 日** (2026-05-03 起点) なので、間に合うバッファあり。**ただし PR #6/#7/#8 が遅延した場合は v1.x 後送り** とし、必達条件にはしない。

---

## 3. PR 分割計画

### 3.1 PR-X1: スキーマ拡張 + 管理テナント + 認可ヘルパ (工数 1-2 日)

| カテゴリ | タスク |
|---|---|
| **schema migration** | `User.systemRole` の許容値に `'super_admin'` を追加 (列定義は `VarChar(20)` のままで OK)。validator (zod) を更新して 3 値 (`'general' \| 'admin' \| 'super_admin'`) に拡張 |
| **管理テナント seed** | UUID `00000000-0000-0000-0000-FFFFFFFFFFFF` で `Tenant` レコード作成 (name='Knowledge Relay Platform'、plan='pro'、`monthlyApiCallCap=null`)。`prisma/seed.ts` に追加 |
| **初期 super_admin 登録** | `SUPER_ADMIN_INITIAL_EMAIL` / `SUPER_ADMIN_INITIAL_PASSWORD` / `SUPER_ADMIN_INITIAL_NAME` 環境変数経由で User 作成、bcrypt 化、`forcePasswordChange=true` セット |
| **認可ヘルパ追加** | `src/lib/permissions/role.ts` (新規) に以下を追加:<br>- `isSuperAdmin(user): boolean`<br>- `isAdminOrAbove(user): boolean` (admin or super_admin)<br>- `isTenantAdmin(user): boolean` (admin のみ)<br>- `requireSuperAdmin(user): void` (throws if not) |
| **既存コードの選択的置換** | 「**全テナント横断で見たい**」用途に該当する既存 `=== 'admin'` チェックを `isSuperAdmin()` に置換。例: `/admin/audit-logs`, `/admin/role-changes` 等の admin 系画面 (これらは v1.x で super_admin 専用に移行する想定) |
| **テスト追加** | `src/lib/permissions/role.test.ts`、seed migration テスト、認可ヘルパの単体テスト |

**マイグレーション手順** (本番 Supabase):
1. `pnpm prisma migrate deploy` で migration 適用 (列定義は変わらないので no-op、validator のみ実装に追加)
2. `pnpm tsx prisma/seed.ts` で管理テナント + super_admin user を seed
3. 既存 admin ユーザはそのまま (意味再解釈で「テナント管理者」になる、コード変更なし)

### 3.2 PR-X2: super_admin ダッシュボード (Phase 1 機能、工数 2-3 日)

ルート: `/admin/super` (super_admin のみアクセス可能)

| 画面 | 内容 |
|---|---|
| `/admin/super/tenants` | 全テナント一覧 (テナント名 / プラン / 月次 API 呼び出し数 / 月次費用 / アクティブユーザ数 / 作成日)。ソート・検索可 |
| `/admin/super/tenants/[id]` | テナント詳細 (使用量推移グラフ / DB 容量内訳 / entity 数 (Project/Knowledge/RiskIssue/Retrospective/Memo の集計)) |
| `/admin/super/usage` | 全テナント横断の使用量サマリ (Voyage 200M 残量 / Anthropic 月次費用 / Supabase DB 容量。CRON 等で日次集計しキャッシュ) |
| ナビゲーション | `dashboard-header.tsx` に super_admin のみ表示される `/admin/super` リンクを追加 |

**主要なサーバ実装**:
- `src/services/super-admin.service.ts` (新規) — テナント横断クエリ。`requireSuperAdmin` でガード
- `src/app/api/admin/super/tenants/route.ts` (新規) — 全テナント一覧 API
- `src/app/api/admin/super/tenants/[id]/usage/route.ts` (新規) — 使用量詳細 API
- E2E テスト (`super_admin-dashboard.spec.ts`) で権限境界 (admin / general はアクセス拒否) を確認

### 3.3 PR-X3: UI 文言 + ドキュメント更新 (工数 1 日)

| 対象 | 変更内容 |
|---|---|
| `src/components/dashboard-header.tsx` 等 | UI Badge 表示「管理者」→「**テナント管理者**」(admin) / 「**システム管理者**」(super_admin) |
| `src/app/(dashboard)/admin/users/users-client.tsx` | systemRole 表示に super_admin の Badge 追加 |
| `docs/specification/PERMISSION_MATRIX.md` | 3 ロール対応に更新。super_admin 列を追加 |
| `docs/business/USER_ROLES.md` | super_admin の役割定義追加 |
| `docs/specification/SUGGESTION_FEATURE.md` | 監視責務の主体を super_admin と明示 |
| `docs/operations/SECURITY_OPS.md` | super_admin アカウント運用手順 (パスワード初期化 / ローテーション) を追記 |
| `CLAUDE.md` | 役割の再解釈について簡潔な注記 |

---

## 4. リスクと対策

| リスク | 対策 |
|---|---|
| 既存 `=== 'admin'` チェックの一部が **本来 super_admin 限定であるべき** ものを admin に許してしまう | PR-X1 着手前に全 36 箇所をレビューし、用途を分類 (テナント内 / 全テナント横断)。横断用途のみ `isSuperAdmin` に置換 |
| seed migration が複数回実行された場合に super_admin が重複作成される | seed を `upsert` で実装 (email を unique key に) |
| `SUPER_ADMIN_INITIAL_PASSWORD` が漏洩した場合の影響 | `forcePasswordChange=true` で初回ログイン時に強制変更。Vercel 環境変数に登録後、teppei さん本人がログイン → 即変更で初期 PW を無効化 |
| 管理テナントの `tenantId` が普通のテナントとして扱われ集計に混入 | 集計クエリで `tenantId != '00000000-0000-0000-0000-FFFFFFFFFFFF'` を必須付与。`isManagementTenant()` ヘルパを `src/lib/tenant.ts` に追加 |
| Phase 2 機能 (impersonate) の設計が複雑化 | 6/1 リリース時点では Phase 1 機能のみ実装、Phase 2 は別 PR で十分時間を取って設計 |

---

## 5. 完了条件 (Definition of Done)

### PR-X1
- [ ] `User.systemRole` validator が `'general' | 'admin' | 'super_admin'` を許容
- [ ] 管理テナント (UUID `...FFFFFFFFFFFF`、name='Knowledge Relay Platform') が seed で作成される
- [ ] `SUPER_ADMIN_INITIAL_EMAIL/PASSWORD/NAME` 環境変数で super_admin user が seed される
- [ ] `isSuperAdmin` / `isAdminOrAbove` / `isTenantAdmin` / `requireSuperAdmin` ヘルパが追加され単体テスト合格
- [ ] 既存テスト全件 PASS (現状の `'admin'` 値が「テナント管理者」として動作することを確認)

### PR-X2
- [ ] `/admin/super/tenants` で全テナント一覧が表示される
- [ ] `/admin/super/tenants/[id]` で個別テナント詳細が表示される
- [ ] `/admin/super/usage` で全テナント横断の使用量サマリが表示される
- [ ] super_admin 以外 (admin / general) はこれらの画面に **403 でアクセス拒否される** (E2E テストで確認)
- [ ] ナビゲーションに super_admin のみリンクが表示される

### PR-X3
- [ ] UI Badge / 設定画面 / ユーザ管理画面で「テナント管理者」「システム管理者」が正しく表示
- [ ] `PERMISSION_MATRIX.md` / `USER_ROLES.md` / `SUGGESTION_FEATURE.md` / `SECURITY_OPS.md` / `CLAUDE.md` が更新済
- [ ] 文言変更による視覚回帰テスト (visual baseline) を更新 (※必要に応じて `pnpm test:e2e:visual:update`)

### 全 PR 共通
- [ ] `pnpm lint` clean
- [ ] `pnpm test` 全件 PASS
- [ ] `pnpm tsx scripts/security-check.ts` score ≥ 90
- [ ] `pnpm e2e:coverage-check` clean
- [ ] PR レビュー + マージ

---

## 6. ユーザ側 (運営者 = teppei さん) の作業

| # | タスク | 緊急度 | 実施タイミング |
|---|---|---|---|
| 1 | 新 super_admin 用 email アドレスの確定 (例: `admin@knowledge-relay.local` 等) | 🔴 必須 | PR-X1 着手前 |
| 2 | `SUPER_ADMIN_INITIAL_EMAIL` を Vercel に登録 | 🔴 必須 | PR-X1 マージ前 |
| 3 | `SUPER_ADMIN_INITIAL_PASSWORD` を Vercel に登録 (強固な初期 PW) | 🔴 必須 | PR-X1 マージ前 |
| 4 | `SUPER_ADMIN_INITIAL_NAME` を Vercel に登録 (例: 'Platform Admin') | 🔴 必須 | PR-X1 マージ前 |
| 5 | PR-X1 マージ → 本番デプロイ後、初期 PW でログイン → 即変更 | 🔴 必須 | PR-X1 デプロイ直後 |
| 6 | super_admin ダッシュボードで動作確認 (テナント一覧・使用量表示) | 🟡 推奨 | PR-X2 マージ後 |

---

## 7. リリース後の Phase 2 検討事項

| 機能 | 想定実装時期 | 設計時の論点 |
|---|---|---|
| プラン強制変更 (運営者起点) | リリース後 1〜2 ヶ月 | テナント側の同意フロー (突然変更で UX が壊れない設計)、当月課金との相互作用 |
| テナント管理者の impersonate | リリース後 2〜3 ヶ月 | 監査ログ必須 (impersonate 履歴は完全保全)、operations 側で誤操作した場合の責任所在 |
| 全テナント横断 entity 検索 | リリース後 3 ヶ月以降 | 利用シナリオ (e.g. 「ある業界ドメインのナレッジを全テナントから検索」)、テナント側のデータ秘匿性との両立 |

これらは需要が見えてから設計開始するため、現時点では計画書に**スコープのみ**記載し、詳細設計は将来に委ねる。

---

## 8. 関連ドキュメント

- [SUGGESTION_ENGINE_PLAN.md](./SUGGESTION_ENGINE_PLAN.md) — 提案エンジン v2 の実装計画 (PR #6/#7/#8 完了後にロール refactoring 着手)
- [../business/USER_ROLES.md](../business/USER_ROLES.md) — ユーザロール定義 (PR-X3 で更新)
- [../business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md) — テナント運用と課金モデル (super_admin の責務範囲を含む)
- [../specification/PERMISSION_MATRIX.md](../specification/PERMISSION_MATRIX.md) — 画面 × 操作のロール別権限マトリクス (PR-X3 で更新)
- [../specification/SUGGESTION_FEATURE.md](../specification/SUGGESTION_FEATURE.md) — 提案機能の機能仕様 + コスト構造 (PR-X3 で監視責務を super_admin に明示)
- [../operations/MIGRATION_TO_AWS.md](../operations/MIGRATION_TO_AWS.md) — インフラ移行計画 (super_admin が監視するべき指標と整合)

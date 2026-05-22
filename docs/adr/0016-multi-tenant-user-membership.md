# ADR-0016: マルチテナント User Membership 設計 (User.email を tenant-scoped 一意化)

- **Status**: Accepted
- **Date**: 2026-05-20
- **Deciders**: 須山哲平 (運営者)

---

## Context (背景)

### 現状の課題

`User.email` は schema 上 `@@unique([email])` でグローバル一意 ([prisma/schema.prisma:340](../../prisma/schema.prisma#L340))。これは初期 (= シングルテナント前提) には合理的な選択だったが、**マルチテナント本質的な制約** となっており、以下の具体的問題が発生している:

1. **同一個人が複数テナントに所属不可能**
   - コンサル / 兼務 / 大企業の部門横断 シナリオで完全に詰む
   - Slack / Notion / GitHub Org 等のエンタープライズ SaaS では当たり前の構成

2. **テナント削除 → 同 email 再利用で UNIQUE 制約違反**
   - 退職→再雇用、テスト→クリーンアップ→再テスト で致命的に詰む
   - 2026-05-20 の動作確認で実際に再現 (= `/admin/super/tenants` で 500 エラー)
   - エラーが対応すべき 4xx ではなく **500** で返るため UX 著しく悪化

3. **Pre-auth フローでの token 越境セキュリティリスク**
   - 現状 `email` 単独で user 特定 → 複数 tenant に同 email 存在時に**ランダム pick**
   - パスワードリセット token を他テナントで利用可能になる潜在的脆弱性
   - 大企業向けに広がった際に **致命的事故** に繋がる

4. **既存バグの結果として silent fail**
   - [tenant-onboarding.service.ts:293](../../src/services/tenant-onboarding.service.ts#L293) で新規 user に `deletedAt: new Date()` が設定される typo がある
   - `existingEmail` チェック ([L194](../../src/services/tenant-onboarding.service.ts#L194)) が `deletedAt: null` でフィルタ → 過去 user を見落とす
   - 結果として DB UNIQUE 違反で 500 → ユーザ離脱

### 制約

- **MVP リリース予定**: 2026-06-01 (= 残り 12 日)
- **現運用フェーズ**: 個人事業 + 小規模法人がメインターゲット
- **Netlify Personal plan ($9/月)**: wildcard subdomain は Pro plan ($19/月) 必要
- **既存ユーザ数 (本番 DB 確認済)**: 7 ユーザ / 2 テナント (= MANAGEMENT + Default)、duplicate email 0 件、削除済 vs アクティブの衝突 0 件
- **強制ログアウト**: 運営者の判断で「migration 時の JWT 失効による全員強制ログアウト」を許容

### 関連事実

- 既に `EmailVerificationToken.tenantId` / `PasswordResetToken.tenantId` は Phase 2-10 (PR #110+) で必須化済
- JWT には既に `tenantId` 含まれている (= [auth.config.ts:219-282](../../src/lib/auth.config.ts))
- `tokenVersion` チェック実装済 (= L-1 PR, 2026-05-13)
- Recovery codes は user + tenant 単位で発行 (= PR #116)

---

## Decision (採用した決定)

### Schema 変更

```prisma
model User {
  // ...
  email  String @db.VarChar(255)
  // ...
  @@unique([tenantId, email], map: "idx_users_tenant_email")  // ★変更
  // 旧: @@unique([email], map: "idx_users_email")
}
```

これにより:
- 同一個人が複数テナントに同じ email で所属可能
- テナント削除後の email 再利用が UNIQUE 制約衝突を起こさない

### 認証フロー設計: **Option B 採用** (= 組織 ID 入力欄方式)

ログイン / パスワードリセット / lock-status の **pre-auth フロー** で「組織 ID」を明示入力させる。

```
ログイン画面 (/login):
  ┌────────────────────────────┐
  │ 組織 ID:   [acme-corp     ] │
  │ メール:    [taro@example.com] │
  │ パスワード: [••••••••       ] │
  │ [ ログイン ]                  │
  └────────────────────────────┘
```

メールリンク (= 招待 / パスワードリセット) には URL クエリで tenant_slug を埋め込み:
```
https://tasukiba.netlify.app/setup-password?tenant=acme-corp&token=xxx
```

### Pre-auth tenant 解決の抽象化 (= 将来 Option A 移行容易化)

```typescript
// 実装: src/lib/tenant-resolver.ts (新規)
export function resolveTenantSlugFromRequest(req: NextRequest): string | null {
  // Option B (今): URL クエリ or form input
  return req.nextUrl.searchParams.get('tenant') ?? null;
  // 将来 Option A 移行時はこの関数の中身を:
  //   const host = req.headers.get('host');
  //   return extractSubdomain(host);
  // に差し替えるだけ
}
```

呼出元コードは変更不要 → **Option A への移行コスト = ~2 日** に抑える。

### URL ビルダーの一元化

```typescript
// 実装: src/lib/url-builder.ts (新規)
export function buildLoginUrl(tenantSlug: string, baseUrl: string): string {
  return `${baseUrl}/login?tenant=${encodeURIComponent(tenantSlug)}`;
  // Option A 移行時: return `https://${tenantSlug}.${rootDomain}/login`;
}
```

メール送信箇所がこの関数を経由することで、Option A 移行時の URL 形式変更を 1 箇所修正で完了させる。

---

## Consequences (影響)

### Positive

- ✅ **同一個人が複数テナントに所属可能** に (= 大企業展開時の必須要件)
- ✅ **テナント削除後の email 再利用問題が完全解消**
- ✅ **Pre-auth token 越境セキュリティリスク解消**
- ✅ **エンタープライズ SaaS 標準設計** (= Slack / Notion / GitHub Org 系) との整合
- ✅ Option A への将来移行が **~2 日コスト** で可能 (= URL 抽象化により)

### Negative / Trade-off

- ❌ **ログイン UX が 1 ステップ増加** (= 組織 ID 入力)
  - 緩和策: 「組織 ID 忘れ」救済フロー実装、ブラウザに記憶させる
- ❌ **メールリンクが長くなる** (= `?tenant=xxx` query 追加)
- ❌ **既存ユーザの強制ログアウト** (= migration 時の JWT 構造変更)
  - 影響: 本番 7 ユーザのみ、運営者承諾済

### Risk / 留意事項

- ⚠️ **Pre-auth フロー (= login / reset-password / lock-status) の改修ミスはセキュリティ事故直結**
  - 対策: Phase 4 で個別 commit + 個別テスト、KDD §5.X+77 にチェックリスト記録
- ⚠️ **既存 user の migration script は idempotent 必須**
  - 対策: Phase 7 で `INSERT ... ON CONFLICT DO NOTHING` パターン使用、ロールバック SQL も準備
- ⚠️ **テスト改修範囲 (推定 50-100 ファイル) が広範**
  - 対策: grep で正確絞り込み、Phase 6 で集中対応
- ⚠️ **NextAuth v5 + Netlify の Set-Cookie 罠** (= KDD §5.X+33) に再衝突する可能性
  - 対策: tenantSlug は JWT claim ではなく URL query 経由で取得 (= cookie 差替え不要)
- ⚠️ **import API による 90日 Beginner abuse** (Phase 10 追記 / 2026-05-20)
  - リスク: テナント解約 → 同 email で新規 Beginner 払い出し → 旧テナントのエクスポート ZIP を import →
    90日試用を半永久延長できる abuse パターン (Voyage embedding コストが運営者負担で膨張)
  - 対策: **P-B 強化** — Beginner プラン払い出し時に **削除/有効を問わず** どこかに登録履歴のある email を拒否
    (`BEGINNER_REQUIRES_UPGRADE` エラー)。UI は Beginner radio を disable + Expert/Pro 誘導 CTA を提示。
    新規 API `POST /api/auth/check-tenant-eligibility` は UI ヒント専用で、サーバ層が
    `tenant-onboarding.service.ts` で defense-in-depth で最終判定する

---

## Alternatives Considered (検討した代替案)

### Alt-1: Option A (サブドメイン方式)

- **概要**: `acme-corp.tasukiba.app/login` のように subdomain 経由で tenant 識別
- **メリット**:
  - 業界標準 (= Slack / Notion / Atlassian)
  - URL から tenant が明確、ブックマーク 1 つで完結
  - SAML/SSO 統合との親和性高
  - セキュリティ強固 (= URL 偽装困難)
- **不採用理由**:
  - **Netlify Pro plan ($19/月) が必要** (= wildcard subdomain 制約)
  - DNS / インフラ調整に時間がかかり 6/1 リリースに間に合わない可能性
  - 現フェーズ (= 個人事業 + 小規模法人) では UX 向上効果が限定的
  - **将来移行コスト ~2 日** で対応可能なため、後出し可能

### Alt-2: Option C (email → tenant 検索 → 選択画面)

- **概要**: email + password 認証後、所属 tenant 一覧から選択
- **メリット**:
  - UX は近い (= ログイン項目数は同じ)
- **不採用理由**:
  - **email enumeration 攻撃を amplify** (= 「この email が複数組織に登録されている」を露出)
  - email が事実上グローバル一意のままになり、本 ADR の目的を達成しない
  - パスワードリセット時の「どの組織?」問題が解決しない

### Alt-3: 現状維持 (= email グローバル一意のまま)

- **不採用理由**: 既に課題が顕在化、放置すれば事業継続性に直結

---

## Future Migration Plan (= Option A 移行ロードマップ)

以下のトリガーで Option A への移行を実施:

| トリガー | 移行判断基準 |
|---|---|
| 大企業導入の具体的引合 | 「subdomain 形式希望」要望が出た時 |
| SAML/SSO 統合要望 | subdomain 単位の IdP 設定が必要になった時 |
| 月次 ARR が ¥100,000 を超過 | Netlify Pro plan ($19/月) 投資を回収可能と判断した時 |
| カスタムドメイン (= `app.顧客企業ドメイン`) 要望 | wildcard ドメイン対応が必要になった時 |

### 移行手順 (= 概算 ~2 日)

1. Netlify Pro plan 契約 + wildcard subdomain 設定 (= `*.tasukiba.app`)
2. `tenant-resolver.ts` の `resolveTenantSlugFromRequest()` を subdomain 抽出に差替
3. `url-builder.ts` の `buildLoginUrl()` を subdomain 形式に差替
4. ログイン画面の「組織 ID」入力欄を削除 (= subdomain から自動取得)
5. メールリンクの形式変更 + 既存リンクの redirect 対応
6. ステージング検証 → 本番リリース

---

## Related (関連情報)

- 詳細設計: [docs/design/AUTHENTICATION.md](../design/AUTHENTICATION.md)
- 運用手順: [docs/operations/MULTI_TENANT_OPERATIONS.md](../operations/MULTI_TENANT_OPERATIONS.md)
- 関連 ADR: 
  - [ADR-0001 マルチテナント基盤](./0001-multitenant-foundation.md)
  - [ADR-0005 RBAC + Two-Stage Tenant Authorization](./0005-rbac-two-stage-tenant-authorization.md)
  - [ADR-0009 NextAuth Credentials + MFA TOTP](./0009-nextauth-credentials-mfa-totp.md)
- 関連 KDD: [§5.X+77 multi-tenant 移行の教訓](../knowledge/KDD_PATTERNS.md)
- 関連 PR: PR #418 想定 (= 本 ADR の実装、PR 番号は作成時に確定)
- 過去の課題発生: 2026-05-20 動作確認で `/admin/super/tenants` が 500 で失敗

---

## Revised: 2026-05-22 — 3 層 eligibility 判定 (4 条件 OR → initialAdminEmail 単独キー化)

### 背景

2026-05-22 動作確認で、Default テナント所属ユーザ (teppei.suyama@pwc.com) が `/signup` から自テナントを Expert プランで払い出そうとした際、UI で Expert を選択しているにも関わらず **`BEGINNER_REQUIRES_UPGRADE` エラーで詰む** 不具合が発覚した。

原因解析の結果、本 ADR (オリジナル / 2026-05-20) には 2 種類の dead code 残置が共存していた:

1. **`/api/auth/signup` 経路の plan 強制上書き** (`onboardingInput.plan = 'beginner';` @ `src/app/api/auth/signup/route.ts:90`)
   - 旧 P-B (2026-05-08) で導入。「公開セルフサインアップは Beginner 限定」方針。
   - 本 ADR 採択 (2026-05-20) で UI 側に「Expert/Pro 誘導 CTA」を入れた際に **削除すべきだったが、route.ts 側の対応が漏れた**。
   - 結果: UI が `plan: 'expert'` を送信しても route.ts が `plan: 'beginner'` に書き換えてしまう dead path 化。

2. **4 条件 OR 判定の false positive リスク**
   - 本 ADR (オリジナル) では「`tenants.billing_contact_email` ∪ `users.email`」× 「`billingContactEmail` ∪ `initialAdminEmail`」の 4 条件 OR で「過去登録履歴あり」を判定。
   - 共有 billing email (会計士代行 / 経理代表アドレス) を使う legitimate user に false positive を発生させていた。
   - 検出強度を上げても、abuse 側は email を変えれば回避可能なため、防御効果と false positive のトレードオフが悪い。

### 仕様変更

**1. プラン強制上書きの撤廃**

`/api/auth/signup` から `onboardingInput.plan = 'beginner';` を削除。`plan` は Zod enum (`beginner` | `expert` | `pro`) と本 Revised の 3 層判定で正規化する。

**2. 4 条件 OR → 3 層 (initialAdminEmail のみ)**

判定キーを `initialAdminEmail` 単独に絞り、検出粒度を **3 層** に拡張:

| 層 | 判定条件 | 公開フォーム挙動 |
|---|---|---|
| 層 1 | `users.email = initialAdminEmail` を持つ user が、いずれかの `tenants.created_by_user_id` に紐付き (= 自前テナント保有) | **完全不可** (`OWNED_TENANT_EXISTS`) → admin 問合せ動線 |
| 層 2 | `users.email = initialAdminEmail` あり (= 招待 / Default 所属のみ) | **Expert / Pro のみ** (`BEGINNER_REQUIRES_UPGRADE`) |
| 層 3 | `users.email = initialAdminEmail` なし | 全プラン可 |

`billingContactEmail` の重複は判定対象外。

**3. SA-2: super_admin 経路は判定全スキップ**

`createTenantBySuperAdmin` は `skipEligibilityCheck=true` で 3 層判定を完全バイパス。これは「層 1 該当ユーザの問合せに応じた admin による例外発行」を運用ルートとして提供するため。1 ユーザの複数自前テナント保有を super_admin 経由で許容するが、ユーザ自身の追加公開払い出しは禁止のまま。

**4. Schema 拡張**

`tenants.created_by_user_id String?` (Uuid) を追加。`Tenant.suspendedBy` と同じ設計 (= User.id への FK にしない、nullable で safe margin)。

- migration: `20260527_tenants_created_by_user_id_tracking`
- backfill: 各 tenant の `systemRole='admin'` の最古 user を `created_by_user_id` にセット (= MANAGEMENT / Default を含む既存 2 テナントを対応)
- 新規テナント作成は `tenant-onboarding.service.ts` が transaction 内で `tenant.update` でセット

### Trade-offs

**喪失する検出 (3 層 Revised では block されなくなる)**:

- A: 過去 Beginner で開設した billingContactEmail で、新 admin email を使って再申込
- B: 共有 billing email (会計士 / 代行業者) で複数テナント開設 — ただしこれは **正当用途の false positive 抑制** が目的
- C: ある admin email が過去に「請求先メール」として登録された後、その email でテナント開設 (レアケース)

**維持される検出**:

- D: 退会済テナントの admin email で再申込 (Beginner 90 日 abuse の本丸) — 層 2 で block (Expert/Pro 誘導)
- E: Default テナントの所属ユーザが自前テナント払い出し — 層 2 で block

**残る abuse 経路** (本 Revised でも防止不可、技術的限界):

- email を変えて 90 日試用を使い回す (gmail エイリアス、捨てメール) — 完全防止不可能

### 影響範囲

- バックエンド: `tenant-onboarding.service.ts` / `signup/route.ts` / `admin/super/tenants/route.ts` / `check-tenant-eligibility/route.ts`
- フロントエンド: `(auth)/signup/page.tsx` (層 1 でフォーム全体 disable + Discord 動線)
- DB schema: `Tenant.createdByUserId` 追加 + 既存 2 テナント backfill
- テスト: 3 層判定の単体テスト (service / check-tenant-eligibility / signup route) + E2E (`e2e/specs/14-signup-3tier-eligibility.spec.ts`)
- ドキュメント: `docs/business/TENANT_AND_BILLING.md` §34.14.5b に正仕様

### 教訓

1. **仕様転換時の dead code 残置**: 上書きロジックを廃止する際、API ハンドラと UI を **同じ PR でセット変更** すること。片方だけ撤去すると逆方向の整合性破壊が生じる。
2. **4 コネクタ OR の false positive リスク**: 検出条件を OR で増やすと、abuse 防止の限界利益よりも legitimate user の誤 block 損失の方が大きいケースが多い。
3. **シンプル設計の力**: 「1 user = 1 email = 1 owned tenant」の概念で簡潔に表現することで、UX 説明も実装テストもクリーンに収まる。

### 運用注意 (将来の保守者向け)

**A. user 物理削除時の created_by_user_id 孤立リスク**

`tenants.created_by_user_id` は `User.id` への soft pointer (FK 不使用) のため、user 物理削除で **宙吊り** になる。すると:

- 当該 email を持つ user が DB から消える
- `users.email = X` クエリが空になり、層 1 判定が「該当なし」と返す
- 結果: 「過去に自前テナントを作成した email」で 層 3 (新規) 扱いされてしまう (security-relaxing)

**現状の影響**: 既存運用では user の論理削除 (`deletedAt` セット) のみで物理削除はしない設計のため顕在化しない。Beginner expiry cron で tenant 物理削除を実行する経路はあるが、user は tenant.delete cascade で消える流れ。

**将来の対策候補**:
1. user 物理削除を実装する際、`tenants.created_by_user_id = u.id` の tenant が存在すれば削除を拒否、または created_by_user_id を NULL に明示更新するロジックを追加
2. `Tenant.createdByUserId` を `User.id` への FK + `ON DELETE RESTRICT` にする (= user 削除を tenant 経由で物理ブロック)
3. user 削除時に「該当 email のハッシュを別 tombstone テーブルに保管」し層 1 判定で参照

**B. email 変更経路追加時の整合性**

現状 user.email は immutable (変更 API なし) のため、層 1 判定は安定して動作する。将来 email 変更機能を追加する場合は、以下のいずれかが必要:

1. 旧 email の tombstone を保持し、層 1 判定で「過去使用していた email」も対象にする
2. 層 1 判定キーを email から user.id ベースに切替 (= 「現在ログイン中の user.id が created_by_user_id に含まれるか」で判定。ただし未ログイン状態の signup には適用不可)
3. email 変更時に「変更前 email を持つ user は別レコードとして残し、新 email の user を別に作る」モデルへ (= 設計大改修)

**C. MANAGEMENT テナントの seed integrity**

MANAGEMENT テナントの初期 admin (= super_admin) は `systemRole='super_admin'` であり 'admin' ではないため、migration backfill SQL は `('admin', 'super_admin')` の双方を含める必要がある (= 2026-05-22 migration で対応済)。新規環境 initialization 時は `prisma/seed.ts` が super_admin user 作成後 (or 既存検出時) に `MANAGEMENT.createdByUserId` を **明示的に上書き** する設計で integrity を担保している。

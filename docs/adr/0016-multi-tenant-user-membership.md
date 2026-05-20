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

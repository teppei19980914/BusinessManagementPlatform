# ADR-0037: テナントバナー (テナント管理者が自テナント向けに設定する期間限定帯メッセージ)

- **Status**: Accepted
- **Date**: 2026-06-27
- **Deciders**: PM (teppei) + Claude Code
- **Related**:
  - [ADR-0036](./0036-system-broadcast-banner.md) システム周知バナー — 設計・実装パターンを踏襲
  - [ADR-0024](./0024-explicit-tenant-id-no-db-default.md) tenant_id に DB DEFAULT を付けない原則

---

## Context (背景)

[ADR-0036](./0036-system-broadcast-banner.md) で super_admin が**全テナント共通**の周知バナーを出す機能を実装した。一方で「自テナントのユーザだけに表示する帯メッセージ」のニーズがあった。例:

- メンテナンス予告 (そのテナントの業務に影響する範囲のみ)
- 社内イベント告知・締め切り通知
- テナント固有のオペレーション周知

super_admin がテナント代行で設定するのは運用負荷が高く、各テナントの**管理者 (tenant_admin = `systemRole === 'admin'`) が自力で設定・取り下げできる**仕組みが必要。

---

## Decision (採用した決定)

### 1. スコープ = 自テナントのユーザのみ (テナント分離徹底)

- `TenantBanner` モデルに `tenantId` を持たせ、取得・変更・削除の全操作で `WHERE tenant_id = :tenantId` を必須とする。
- `tenantId` は **セッション (`session.user.tenantId`) から取得**し、URL パラメータ・リクエストボディからは受け取らない (越境攻撃の入口を排除)。
- ADR-0024 の `tenant_id に DB DEFAULT を付けない` 原則に従い、`create` 時は常に `tenantId` を明示してセットする。

### 2. ADR-0036 の設計パターンを踏襲

ADR-0036 のシステムバナーと**同一の UI コンポーネント (`SystemBannerBar`)** を再利用し、差分は API パスと `tenantId` スコープのみとする。

| 項目 | SystemBanner (ADR-0036) | TenantBanner (本 ADR) |
|---|---|---|
| テーブル | `system_banners` (テナント列なし) | `tenant_banners` (tenantId 必須) |
| 操作権限 | super_admin のみ | tenant_admin のみ (自テナント) |
| 表示対象 | 全テナントの全ユーザ | 当該テナントのユーザのみ |
| API パス | `/api/admin/super/banners` | `/api/tenants/me/banners` |
| 1本制約 | グローバル (全テナント横断) | テナント内 (他テナントとは独立) |
| UI バナー UI | `SystemBannerBar` | `SystemBannerBar` (共用) |

### 3. 同時1本制約はテナント内で独立

- SystemBanner との1本制約は**互いに独立**。SystemBanner が有効でも TenantBanner を作成できる (合計2本同時表示は可)。
- テナント内では有効なバナーの表示期間重複を 409 `OVERLAP` で弾く (ADR-0036 §2 と同じロジック)。
- 1テナントで最大同時表示 1 本 + システムバナー最大 1 本 = 最大 2 本。

### 4. 表示優先度と重みソート (ADR-0036 との統合)

`src/app/(dashboard)/layout.tsx` で SystemBanner と TenantBanner を `Promise.all` で並列取得し、**severity の重みで降順ソート**して上から描画する。

```
severity weight: high=3, medium=2, low=1
同一 severity: SystemBanner が上 (tie-break)
```

レンダリングは `SystemBannerBar` を繰り返し描画するだけ (追加コンポーネント不要)。

### 5. 管理 UI は `/settings/tenant` の 4 番目のタブ「バナー」

`/settings/tenant?tab=banner` タブから `/settings/tenant/banners/` 管理ページへ誘導する。管理ページの構成は ADR-0036 の `/admin/super/banners/` と同じ — 一覧・新規作成・編集・複製・取り下げ・削除。

### 6. 「期間なし」は不採用

`startAt` / `endAt` を必須とし、システムバナーと同じ期間管理モデルを採用する。即時〜無期限の運用には `startAt = 今` / `endAt = 遠い未来` で代替できる。

---

## Consequences (結果)

### 良い点
- ADR-0036 の設計・実装をほぼそのまま踏襲でき、新規設計コストが最小。
- `SystemBannerBar` の再利用でコンポーネント増加なし。
- テナント分離が `tenantId` の WHERE 強制という構造的手段で担保される。
- super_admin の手を煩わせず、各テナントが自律的にバナー運用できる。

### トレードオフ / 留意点
- `layout.tsx` に DB クエリが1本追加される (全ダッシュボードロード)。`(tenant_id, enabled, start_at, end_at)` の複合インデックスで軽量化し、取得失敗は best-effort で握りつぶす。
- 2 本同時表示 (system + tenant) が発生しうる。ヘッダー下の帯が2段になるため、頻発すると UX に影響する。ただし通常運用では SystemBanner は稀で、TenantBanner は各テナントが裁量を持つため許容範囲とする。
- `tenant_admin` の定義は `isTenantAdmin(user)` = `user.systemRole === 'admin'` 限定。`super_admin` は本機能の対象外 (super_admin は管理テナントに所属し、一般テナントの日常運用は行わない)。

---

## 実装ファイル

| ファイル | 役割 |
|---|---|
| `prisma/schema.prisma` | `TenantBanner` モデル追加 + `Tenant.tenantBanners` リレーション |
| `prisma/migrations/20260627_add_tenant_banner/` | DDL: `tenant_banners` テーブル + インデックス |
| `src/lib/validators/tenant-banner.ts` | Zod スキーマ (createTenantBannerSchema / updateTenantBannerSchema) |
| `src/services/tenant-banner.service.ts` | CRUD + 重複チェック + テナント分離保証 |
| `src/app/api/tenants/me/banners/route.ts` | GET / POST |
| `src/app/api/tenants/me/banners/[id]/route.ts` | PATCH / DELETE |
| `src/app/(dashboard)/settings/tenant/banners/` | 管理 UI (一覧 / 新規 / 編集) |
| `src/app/(dashboard)/settings/tenant/tab-helpers.ts` | `'banner'` タブ型追加 |
| `src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx` | 4 番目のバナータブ追加 |
| `src/app/(dashboard)/layout.tsx` | 並列取得 + 重みソート + 描画 |
| `src/services/tenant-banner.service.test.ts` | 単体テスト (CRUD + テナント分離 7 件) |
| `e2e/specs/22-tenant-banner.spec.ts` | E2E テスト (表示 / × 閉じ / OVERLAP / 管理画面) |

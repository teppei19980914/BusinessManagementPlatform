# ADR-0036: システム周知バナー (全テナント共通・期間指定・緊急度色分け・セッション内×破棄)

- **Status**: Accepted
- **Date**: 2026-06-08
- **Deciders**: PM (teppei) + Claude Code
- **Related**:
  - [ADR-0008](./0008-graceful-degradation-mode.md) 縮退モードバナー (DegradedModeBanner) — 表示帯の実装雛形を流用
  - [ADR-0037](./0037-tenant-banner.md) テナントバナー — 本 ADR の設計を踏襲し、テナント管理者が自テナント向けに設定するバナー機能 (v1.5.0)
  - `src/app/(dashboard)/layout.tsx` のコメント (feat/app-header-footer-unification / 2026-05-24) — 「AnnouncementBanner を画面上部から廃止。critical な周知が必要になった場合は別途検討する」とした **その別途検討の結論**が本 ADR

---

## Context (背景)

たすきばには「お知らせ画面」(`docs/public/announcements/*.md` を読む恒久ページ) と「通知ベル」(ユーザ個人宛の `Notification`) が既にある。一方で、**メンテナンス告知のような「全ユーザに今すぐ気づかせたい一時的な周知」** を出す手段がない。

過去 (2026-05-24) に常時表示の `AnnouncementBanner` を「画面の表示項目を減らす」方針で撤去した経緯があり、layout のコメントに「critical な周知が必要になった場合は別途検討」と明記されていた。今回その要件が顕在化したため、**運営者 (super_admin) が期間と緊急度を指定して出す画面上部の帯メッセージ**を再導入する。

### 既存の類似概念との違い

| 概念 | 実体 | 用途 | 本機能との違い |
|---|---|---|---|
| お知らせ画面 | markdown / Git 管理 / 公開ページ | 恒久的な告知記事 | 帯ではない・期限で自動消滅しない |
| 通知ベル | `Notification` モデル / ユーザ個人宛 | @メンション・期日リマインド | ユーザ単位・帯ではない |
| **システム周知バナー (本 ADR)** | `SystemBanner` モデル / DB | 期間限定・全ユーザ共通の運用周知 | 期間で自動表示/消滅・緊急度色分け・×で当セッション破棄 |

---

## Decision (採用した決定)

### 1. スコープ = 全テナント共通 (グローバル)

super_admin はたすきば全体の運営者であり、複数テナントを横断する。周知はメンテナンス告知等の運用連絡が主目的のため、`SystemBanner` は **`tenantId` を持たない**グローバルテーブルとする (全テナントの全ログインユーザに同一の帯を表示)。

> [ADR-0024](./0024-explicit-tenant-id-no-db-default.md) の「tenant_id に DB DEFAULT を付けない」原則は **tenant スコープのテーブルに対する規律**。本テーブルは意図的に非テナントスコープであり、`tenant_id` カラム自体を持たないため対象外。

### 2. 表示条件と「同時に1本」制約

- 表示条件: `enabled = true` かつ `start_at <= now < end_at`。
- **1本制約**: 作成・編集時に、**enabled な既存バナーと表示期間が重複することを禁止** (重複時は 409 `OVERLAP`)。これにより「ある時点で表示される帯は最大1本」を構造的に保証する。
  - 重複判定の対象は **enabled=true のバナーのみ**。取り下げ (enabled=false) 済み・期間が完全に過去のものは枠を空ける (新規作成を妨げない)。

### 3. 取り下げ (enabled) と物理削除の2系統 + 履歴保持

- **取り下げ / 再開** (`enabled` フラグ): 表示中の帯を即時に止める/再開する。**履歴には残る** (= 「いつ何を出したか」を後から参照・複製できる)。
- **物理削除** (`DELETE`): 誤作成したバナーを履歴ごと削除する (運用ミスの後始末用)。
- 一覧画面が「履歴」を兼ね、状態 (表示中 / 予約 / 終了 / 停止) をバッジ表示する。過去バナーから **複製**して新規ドラフトに内容・緊急度をコピーできる (複製は新しい id を持つため、過去に×で消したユーザにも再表示される)。

### 4. 緊急度3段階 → 色

| 緊急度 | severity 値 | 色 |
|---|---|---|
| 高 | `high` | 赤地・白文字 |
| 中 | `medium` | 黄地・濃色文字 (コントラスト確保) |
| 低 | `low` | 青地・白文字 |

severity の値は `src/lib/validators/system-banner.ts` の `BANNER_SEVERITIES` (`as const` 配列) を**単一ソース**とし、型・zod 許可リスト・ラベル・色マップをそこから導出する ([[feedback_union_value_runtime_validator_drift]] の再発防止)。

### 5. ×破棄はセッション内維持 / 再ログインで再表示

- ×ボタンで閉じた帯は、**確立中のセッション内では再表示しない** (`sessionStorage` に破棄済 banner id を保持)。
- 破棄状態は **userId でスコープ**し ([[feedback_client_sessionstorage_user_isolation]] のユーザ越境防御を踏襲)、`useSession()` の `status === 'unauthenticated'` 遷移時に全 purge する。これにより **ログアウト → 再ログイン後は (期間内であれば) 帯が再表示**される。

### 6. 表示面 = ログイン後の全ダッシュボード画面

`src/app/(dashboard)/layout.tsx` の既存 SSR 並列取得 (`Promise.all`) に有効バナー取得を相乗りし、`DegradedModeBanner` 直下に描画する。ログイン画面・公開ページには出さない (「確立されたセッション内」という要件に合致)。

---

## Consequences (結果)

### 良い点
- 既存資産 (DegradedModeBanner / chat-history のユーザ分離 / super_admin 認可レイアウト / tenant-create-form の UI パターン) をほぼそのまま流用でき、新規設計が最小。
- グローバルテーブルのため、テナント分離ロジックの複雑化を持ち込まない。

### トレードオフ / 留意点
- layout に DB クエリが1つ増える (全ダッシュボードロード)。`(enabled, start_at, end_at)` の複合インデックスで軽量化し、取得失敗は best-effort で握りつぶす (画面遷移を妨げない)。
- 日時は super_admin のブラウザ TZ (JST 運用前提) で入力 → ISO に変換して `timestamptz` 保存。
- 監査ログ (`recordAuditLog`) はグローバル操作だが `tenant_id`/`entity_id` が UUID 必須のため、`tenant_id` = super_admin 所属の管理テナント ID、`entity_id` = banner.id (UUID) を用いる ([[feedback_auditlog_uuid_strict_type]])。

### 非対象 (将来課題)
- テナント指定配信 (特定テナントだけに出す) は今回スコープ外 (`tenantId` 追加で対応可能)。
- 複数バナーの同時積み上げ表示は不採用 (1本制約)。

---

## 実装上の既知の落とし穴 (v1.4.0 デグレ教訓)

### バナー内リンクの色は親側で上書きすること

`MarkdownDisplay` および `linkifyNodes` が生成する `<a>` 要素は `text-info`
(`oklch(0.55 0.18 240)` ≈ blue-600) で固定されている。バナー背景が同系色
(`low` = `bg-blue-600`) または白文字背景 (`high` = `bg-red-600`) の場合、
リンクが背景に溶け込み WCAG AA のコントラスト比 (4.5:1) を大幅に下回る。

**必須**: バナーメッセージを描画するコンテナには必ず `[&_a]:text-current` を付与し、
親の文字色 (`text-white` / `text-yellow-950`) をリンクに継承させること。

```tsx
// ✅ 正しい実装 (src/components/system-banner-bar.tsx)
<div className="flex-1 [&_a]:text-current [&_a]:font-semibold">
  <MarkdownDisplay value={banner.message} />
</div>

// ❌ NGパターン — MarkdownDisplay に切り替えた際に [&_a]:text-current を外すと
//   blue-on-blue 等でリンクが見えなくなる (v1.4.0 でのデグレ原因)
<div className="flex-1">
  <MarkdownDisplay value={banner.message} />
</div>
```

**自動検出**: `e2e/specs/21-system-banner.spec.ts` の axe-core テスト (観点 7) が
`@axe-core/playwright` で `color-contrast` ルールを検査し、この種のデグレを CI で検知する。

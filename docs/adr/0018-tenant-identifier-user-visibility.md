# ADR-0018: テナント識別子のユーザ可視化と設定画面の情報分離

- **Status**: Accepted
- **Date**: 2026-05-21
- **Deciders**: teppei0914 (オーナー)

---

## Context (背景)

ADR-0016 (multi-tenant user membership) により、ログインには「組織 ID (= `Tenant.slug`) + メール + パスワード」の 3 要素が必須となった。同じメールが複数テナントに所属しうるため、メール単独ではユーザを一意特定できず、組織 ID の入力が必須化されている。

しかし本 ADR 制定時点では、組織 ID (`Tenant.slug`) の値はテナント管理者向け画面 (`/settings/tenant`) でも独立ラベルとして表示されておらず (`Tenant.name` と `Tenant.tenantSeq` のみ表示)、一般ユーザに至っては自分の所属テナントの slug を確認する手段が UI 上一切存在しなかった。

そのため:

- 一般ユーザが「次回ログイン時の組織 ID」を確認できず、管理者にその都度問い合わせる必要があった。
- 管理者本人にとっても、招待時にユーザに伝えるべき値が UI ラベルとして明示されていないため、`tenantSeq` (連番) と `slug` を混同するリスクがあった。
- PR #420 で localStorage ベースの「組織 ID 履歴 (LRU 5 件)」が追加されたが、これは同一ブラウザでログイン履歴がある場合の負担軽減のみで、初回ログイン・別ブラウザ・引継ぎ・履歴クリア後には機能しない。

一方、ユーザ個別設定画面 (`/settings`) は従来「画面テーマ・パスワード変更・MFA」の 3 機能のみで、「自分のメール / 氏名 / ロール / 最終ログイン」といったアカウント情報の確認手段すら備えていなかった。

「どの情報をどの画面に置くか」の方針が暗黙的に「テナント関連は全て管理者画面」となっていたため、これを明示的に再定義する必要があった。

## Decision (採用した決定)

**ユーザ個別設定画面とテナント設定画面の情報配置を、以下の原則で再定義する**:

1. **ユーザ個別設定画面 (`/settings`)** には、ユーザ自身が知るべき情報 + 個人の好みを置く。
   - 組織 ID (`Tenant.slug`)、テナント表示名 (`Tenant.name`)
   - 自分のメール (`User.email`)、氏名 (`User.name`)、ロール (`User.systemRole`)、最終ログイン (`User.lastLoginAt`)
   - 既存: テーマ、パスワード変更、MFA
2. **テナント設定画面 (`/settings/tenant`)** には、テナント管理者のみが扱う情報を置く。
   - 組織 ID (`Tenant.slug`) を独立ラベルで明示 (= ユーザに伝える正規値の明示化)
   - テナント停止理由 (`Tenant.suspendReason`) の業務文言バナー表示
   - サポート用詳細欄 (折りたたみ): UUID / 作成日時 / プラン単価 / カード検証 / 自動停止予定
   - 既存: プラン / 予算 / 使用量 / 請求先 / Stripe / 解約 等
3. **テナント識別子の粒度**:
   - ユーザ個別設定では `slug` + `name` のみ。`tenantSeq` / UUID は載せない (認知負荷削減)。
   - テナント設定では `slug` (独立) + `name` + `tenantSeq` (ヘッダ) + UUID (詳細欄) を載せる。
4. **メンバー一覧 / 権限管理 UI** は本 ADR のスコープ外 (= 別 PR で扱う)。

## Consequences (影響)

### Positive

- 一般ユーザが「自分の組織 ID」を自己解決で確認でき、管理者問い合わせの恒常的負荷が消える。
- 引継ぎ・別ブラウザ・履歴クリア時にも組織 ID を確認可能 (localStorage 履歴 [PR #420] を補完)。
- ユーザが「自分が super_admin / admin / general のいずれか」を画面で確認でき、MFA 強制有効化の理由 (super_admin だから) も自然に納得できる。
- テナント管理者が招待時にユーザへ伝えるべき値が「組織 ID = `acme-corp` のように明示」されるため、`tenantSeq` (連番) を誤って伝える事故が減る。
- 停止理由バナーにより、管理者が「なぜテナントが read-only モードになっているのか」を即座に把握できる。

### Negative / Trade-off

- `getUserSelfAccountInfo()` の追加で `/settings` 画面のサーバ取得が 1 件増える (User + Tenant join 1 クエリ)。Postgres 側で `users.tenant_id` の FK が貼られているため数 ms オーダーで無視できる。
- ユーザ個別設定の縦スクロールがやや長くなる。アカウント情報は最上部に置き、テーマ / パスワード / MFA は下に押し下げる。

### Risk / 留意事項

- `Tenant.slug` を一般ユーザに見せることで「他テナントへのなりすまし試行」のヒントになるか? — ADR-0016 で email + slug + password の 3 要素必須化済のため、slug 単独露出は影響なし (= ログインには password も必要)。むしろ slug は招待メールリンクの URL クエリにも乗っているため、すでに露出している情報。
- 解約済テナント (`Tenant.deletedAt` セット) のユーザがアカウント情報を引けないようガード (`getUserSelfAccountInfo()` で `tenant.deletedAt != null` のとき null 返却) を入れた。これは解約後の不正アクセスを根本で遮断する設計。

## Alternatives Considered (検討した代替案)

### Alt-1: 一切何も追加せず、localStorage 履歴 (PR #420) のみで運用

- 概要: 設定画面に追加せず、ログイン履歴の localStorage だけで負担軽減する。
- メリット: 実装ゼロ。
- 不採用理由: 同一ブラウザでログイン履歴がない場合 (= 初回 / 別ブラウザ / 引継ぎ / 履歴クリア) には機能せず、本質的な解決にならない。「自分の組織 ID を確認したい」という素朴なニーズに対する答えが存在しない状態が続く。

### Alt-2: テナント識別子 (UUID / `tenantSeq` 含む) を全部ユーザ個別設定に載せる

- 概要: slug + name + tenantSeq + UUID をユーザ個別設定で全表示。
- メリット: サポート問合せ時にユーザが UUID を伝えられる。
- 不採用理由: ユーザにとって UUID は無価値で認知負荷だけ上がる。ログイン入力で使うのは slug のみ、サポート連絡で使うのは管理者経由が前提のため、一般ユーザに UUID を露出する必要なし。

### Alt-3: ユーザ個別設定とは別に「マイページ」を新設してアカウント情報を置く

- 概要: 設定機能 (テーマ / パスワード / MFA) とアカウント情報 (組織 ID / メール / ロール) を画面分離。
- メリット: 役割が明確。
- 不採用理由: ナビゲーション数が増え、ユーザは「両方のページを行き来する」必要が出る。アカウント情報は設定画面で同時参照できた方が体験が良い。

## Related (関連情報)

- 詳細設計: [src/services/user-self.service.ts](../../src/services/user-self.service.ts) (本 ADR で新設)
- 関連 ADR: [ADR-0016](./0016-multi-tenant-user-membership.md) (tenant-scoped User.email, login の slug 必須化)
- ログイン UX (補完): PR #420 (localStorage tenant 履歴 + datalist)
- 関連画面: [src/app/(dashboard)/settings/page.tsx](../../src/app/(dashboard)/settings/page.tsx), [src/app/(dashboard)/settings/tenant/page.tsx](../../src/app/(dashboard)/settings/tenant/page.tsx)
- スコープ外 (後続): テナント管理者向け「メンバー一覧 / 権限管理 UI」 — 別 PR で実装予定

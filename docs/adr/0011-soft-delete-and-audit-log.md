# ADR-0011: 論理削除 (soft delete) + 全変更操作の監査ログ完全記録

- **Status**: Accepted
- **Date**: 2026-04 (MVP データモデル設計時)
- **Deciders**: teppei

---

## Context

業務情報を扱う SaaS として、データの「いつ・誰が・何を・どう変更したか」を追跡可能にする必要があった。
特に B2B 利用を想定すると、顧客テナント内での操作履歴 (誰が誤って削除したか、誰が金額を改変したか等) を遡及的に確認できる仕組みは、信頼関係の根幹。

検討時の制約:

- **誤削除のリカバリ**: ユーザが誤ってプロジェクト / ナレッジを削除した場合、admin が復元できる必要がある
- **法的・監査要件**: 個人情報を含むデータの変更履歴は一定期間保持する必要 (個人情報保護法・GDPR 相当)
- **関連データの整合性**: あるエンティティを削除しても、それを参照する他データ (例: 監査ログ自体、過去の API 呼出ログ) が壊れないようにしたい
- **検索 / 一覧での「削除済」除外**: 通常の業務画面では削除済データを表示しないが、admin 画面では復元のため見える必要がある
- **テナント削除時の扱い**: テナント全体を解約・削除する場合は物理削除すべき (個人情報保護法に基づく削除要求への対応)
- **改ざん耐性**: 監査ログ自体が改ざんされたら追跡不能。**WORM (Write Once Read Many)** 性が必要

## Decision

**論理削除 (`deleted_at` カラム) を全主要エンティティに採用 + 監査ログを別テーブルに完全記録** する。

### 論理削除の仕様

- **対象エンティティ**: Project / User / Tenant / Knowledge / RiskIssue / Retrospective / Estimate / Task / Memo / Customer 等の業務エンティティ全て
- **カラム**: `deleted_at TIMESTAMP NULL`。NULL = 有効、値あり = 削除済
- **クエリでの除外**: Service 層で `where: { deletedAt: null }` を強制 (Prisma の middleware で自動付与も検討中)
- **復元**: admin 画面で `deleted_at = NULL` に戻すことで復元可能
- **物理削除のタイミング**:
  - **テナント削除時のみ**: 該当テナント配下のデータを全て物理削除 (個人情報保護のため)
  - **論理削除データの自動 purge** は **採用しない** (保持期間を業務ごとに自由に決められないため)

### 監査ログ仕様

- **テーブル**: `audit_logs`
- **記録対象**: CREATE / UPDATE / DELETE / 状態遷移 / 権限変更 / ログイン (auth_event_logs と分離)
- **記録内容**: `actor_user_id`, `tenant_id`, `entity_type`, `entity_id`, `action`, `before` (JSON), `after` (JSON), `ip_address`, `user_agent`, `created_at`
- **WORM 性の担保**:
  - `audit_logs` への INSERT のみ許可、UPDATE / DELETE は Service 層レベルで禁止 (Prisma client にラッパー)
  - 将来的に DB 層での RLS / トリガによる更新拒否を検討
- **保持期間**: 当面無期限。テナント削除時のみ物理削除

### 認証イベントログとの分離

- 認証関連 (login_success / login_failure / mfa_attempt / password_change 等) は別テーブル `auth_event_logs` に分離
- 通常の業務操作とは検索クエリ・保持期間・閲覧権限が異なるため分離する設計

## Consequences

### Positive
- **誤削除のリカバリ可能**: ユーザが「あれ消しちゃった」と気づいた時点で admin が復元できる
- **完全な操作履歴**: 「いつ・誰が・何を・どう変更したか」を遡及的に確認できる
- **テナント解約時の個人情報削除**: 物理削除を明確に「テナント削除時のみ」と限定することで、個人情報保護要件にも対応
- **関連データの整合性**: 論理削除のため、過去の `audit_logs` / `api_call_logs` から参照する `entity_id` が常に有効
- **デバッグ容易性**: 「あの時何が起きた?」の調査が監査ログ + before/after JSON で再現可能

### Negative / Trade-off
- **クエリの煩雑性**: 全クエリに `where.deletedAt = null` が必要 (Prisma middleware で自動化を検討中)
- **DB サイズの肥大化**: 削除されたデータも残るため、長期運用で DB が肥大化。Supabase 無料枠の容量制約 (500MB) との兼ね合いが必要
- **`audit_logs` の肥大化が最も顕著**: 各 CRUD で 1 行追加されるため、業務操作が多いテナントほど急増。Supabase 無料枠を超える可能性
- **ユニーク制約との競合**: 例えば「メールアドレスは tenant 内ユニーク」を `UNIQUE(tenant_id, email)` で実装すると、論理削除されたユーザが残っている状態で同じ email の新規ユーザ追加ができない。**部分ユニーク制約** (`WHERE deleted_at IS NULL`) を使う
- **削除済データの提案エンジン除外**: embedding 検索クエリでも `deleted_at IS NULL` を必ず付与する必要がある (漏れると削除済データが検索結果に出る)

### Risk / 留意事項
- **`deleted_at IS NULL` 漏れがバグ源**: Service 関数追加時のレビューで必ず確認 ([CONTRIBUTING.md §5](../../CONTRIBUTING.md))
- **監査ログの可視性**: テナント admin は自テナント分のみ閲覧可、super_admin はテナント横断閲覧可。**他テナントの監査ログを覗けないことを保証**するのが [ADR-0005](./0005-rbac-two-stage-tenant-authorization.md) の重要点
- **before/after JSON のサニタイズ**: パスワードハッシュ / API キー等の機密フィールドは記録時にマスク。`audit.service.ts` でフィールド allowlist 方式
- **DB 容量モニタリング**: `db-capacity.service.ts` で容量推移を毎日チェック。閾値超過時に admin にアラート

## Alternatives Considered

### Alt-1: 物理削除 (hard delete) + バックアップで対応
- 概要: DELETE クエリで物理削除し、リカバリは Supabase Point-in-Time Recovery 等の DB バックアップから
- メリット: DB サイズ管理が容易、クエリも単純
- 不採用理由: (1) PITR は分単位の復旧であり「特定のレコードだけ復元」が困難 (2) 「誤って削除 → 即時復元」のユースケースに対応できない (3) admin 画面で「削除済データ一覧」を出せない

### Alt-2: 削除済データを別テーブル (`*_archive`) に移動
- 概要: 削除時に対象を archive テーブルに移し、本テーブルから消す
- メリット: 本テーブルが軽量
- 不採用理由: (1) FK 参照が壊れる (audit_logs から削除済 entity を引けない) (2) 復元時に逆方向のデータ移動が必要で実装複雑 (3) スキーマが 2 倍になる

### Alt-3: 監査ログを Append-only Event Store (Kafka 等) に外出し
- 概要: PostgreSQL ではなく専用のイベントストアに記録
- メリット: WORM 性が物理的に担保される
- 不採用理由: 個人 / 少人数開発でインフラ複雑度が見合わない。同じ PostgreSQL に置きつつ Service 層で UPDATE / DELETE を禁止すれば運用上同等

### Alt-4: 監査ログを記録しない (パフォーマンス優先)
- 概要: CRUD のみで記録なし
- メリット: 書込負荷ゼロ
- 不採用理由: B2B SaaS の信頼性根幹が崩れる。「誰が金額を改ざんしたか」を顧客に証明できない

## Related

- 詳細設計: [docs/design/DATA_MODEL.md §4.2](../design/DATA_MODEL.md) / [docs/design/SECURITY.md](../design/SECURITY.md)
- インシデント対応: [docs/operations/INCIDENT_RESPONSE.md §6.5](../operations/INCIDENT_RESPONSE.md) (auth_event_logs の活用例)
- 認可方式 (テナント越境防止): [ADR-0005](./0005-rbac-two-stage-tenant-authorization.md)
- 用語: [docs/business/GLOSSARY.md (監査ログ / 論理削除)](../business/GLOSSARY.md)
- DB 容量モニタリング: `src/services/db-capacity.service.ts` ([docs/business/FEATURE_CATALOG.md](../business/FEATURE_CATALOG.md) G カテゴリ)

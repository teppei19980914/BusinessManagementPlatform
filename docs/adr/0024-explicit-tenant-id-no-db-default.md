# ADR-0024: tenant_id カラムから DB DEFAULT を撤去しコード明示必須化する

- **Status**: Accepted
- **Date**: 2026-05-28
- **Deciders**: teppei_suyama (Tech Lead)

---

## Context (背景)

PR #2 (T-03, 2026-04-15) でマルチテナント基盤を導入した際、`schema.prisma` の各エンティティの `tenantId` カラムに DB レベルの DEFAULT 値 (`@default(dbgenerated("'00000000-0000-0000-0000-000000000001'::uuid"))`) を設定していた。これは「単一テナント運用期 (v1) ではコードが tenantId を渡し忘れても暗黙的に Default テナントへ自動配属される」という暫定設計だった。

しかし 2026-05-28 に **severity-1 のテナント越境セキュリティバグ** が発覚した:

- `src/services/risk.service.ts` の `createRisk()` (line 460)
- `src/services/retrospective.service.ts` の `createRetrospective()` (line 304)

これら 2 つのサービス関数は `tenantId` を引数で受け取っているのに `prisma.X.create({ data: { ... } })` の `data` に渡しておらず、すべての非 Default テナント (test テナント、システム管理者テナント、その他あらゆる一般顧客テナント) が起票したリスク/課題/振り返りが **silent に Default テナントに保存** されていた。

検知経緯:

- testテナントの一般ユーザが「公開範囲: 自分のみ」で課題を起票
- フォーム送信は API 201 で成功表示するが、起票者自身の一覧に「課題がありません」と表示される
- システム管理者ダッシュボードの test テナント統計でも「リスク/課題: 0」と表示
- 全コードスキャン調査により `createRisk` / `createRetrospective` の `data` に `tenantId` が抜けていたことが判明

被害可能性:

- 非 Default テナントの RiskIssue / Retrospective が Default テナントに混入 → 起票者本人には見えない (UX バグ)
- Default テナント側の「全リスク/全課題」横断ビュー (`visibility='public'` のもののみ表示) に他テナントのデータが露出する経路 → **個人情報漏洩リスク (severity-1)**
- Prisma の生成型 (XOR ベース) は「DB DEFAULT を持つカラムは省略可能」と推論するため、TypeScript の型チェックではバグを検知できない (`@@feedback_db_column_removal_6layers`)

## Decision (採用した決定)

`schema.prisma` の **全 13 モデル** から `tenantId @default(dbgenerated tenantId)` を撤去し、`tenantId String @map("tenant_id") @db.Uuid` の NOT NULL カラムのみとする。これにより:

- コードが `data` に `tenantId` を渡さなければ Prisma が NOT NULL 違反エラーで **loud fail** する
- 暗黙的なテナント配属を構造的に不可能化する

対象モデル (13 件):

`User`, `Customer`, `Project`, `RiskIssue`, `Stakeholder`, `Knowledge`, `Retrospective`,
`SystemErrorLog`, `Attachment`, `Comment`, `Mention`, `Notification`, `Memo`

### 唯一の例外: SystemErrorLog の pre-auth fallback

`SystemErrorLog` (システムエラーログ) のみは「pre-auth エラー (ログイン試行失敗、トークン検証失敗等)」を記録する性質上、`tenantId` を取得できないリクエストが発生する。

- 旧仕様: 暗黙の DB DEFAULT で Default テナントに集約
- 新仕様: `error-log.service.ts` 内で `input.tenantId ?? DEFAULT_TENANT_ID` の **明示的な fallback** を行う

DB DEFAULT は撤去するが、コード側で **同等の挙動を明示記述** することで、「ログを失わない」要件と「silent な暗黙挙動を排除する」要件の両立を図る。

## Consequences (影響)

### Positive
- **再発防止**: 同種バグ (`data` に `tenantId` を渡し忘れる) は今後 100% Prisma エラーで検知される
- **可読性向上**: schema を見ても暗黙挙動 (`@default(dbgenerated)`) が無くなり、tenant 配属はコードレビューで完全に追跡可能
- **テナント分離の構造的保証**: severity-1 セキュリティリスクの根本原因を schema レベルで除去
- **DRY 原則**: `pre-auth fallback` のみ唯一の明示経路、それ以外は全コードが `data.tenantId` を渡す統一パターン

### Negative / Trade-off
- **互換性のないコード変更**: `user.service.ts createUser()` の `options.tenantId` が optional から required へ。**呼出元 (現状 1 箇所のみ) とテストコードを書き換える必要がある**
- **DB migration の non-reversible 性**: ALTER TABLE で DEFAULT を撤去するため、ロールバック時は再度 ALTER で復元する必要がある (本 PR では migration の `down` を提供しない方針)
- **既存データの混入修復が別作業**: 過去に Default テナントに silent 混入したレコードは `scripts/migrate-leaked-tenant-data.ts` で修復する (本 ADR の範囲外)

### Risk / 留意事項
- **本番運用時の migration 適用順序**: コード fix と schema migration は **同一 PR で同期適用** する必要がある (schema が先に適用されると古いコードが NOT NULL 違反で全 create を失敗する)
- **テストコードの conditional spread 残置リスク**: `vi.mock` で `prisma` をモックしているテストでは DB DEFAULT は効かないため、tenantId の明示有無は本番と差分が出る。本 PR の regression test (`risk.service.test.ts`, `retrospective.service.test.ts`) で `data` に `tenantId` が含まれることを明示的にアサートする
- **将来の新規モデル追加時**: tenant 配属を持つ新規モデルは必ず `tenantId String @map(...) @db.Uuid` (DEFAULT なし) で定義する。本 ADR を参照する README リンクを `prisma/schema.prisma` の頭にコメントで記述する

## Alternatives Considered (検討した代替案)

### Alt-1: DB DEFAULT を維持し、ESLint カスタムルールでコード側を強制する
- 概要: schema は触らず、`prisma.X.create({ data: ... })` の `data` に `tenantId` が含まれていない場合に lint エラーを出すルールを実装
- メリット: schema migration が不要、ロールバック容易
- 不採用理由:
  - ESLint ルールは TS の型情報を完全に追跡できず、変数経由 (`const data = {...}` を別行で組み立て) のパターンを誤検知/見逃しする
  - silent 挙動の根本原因 (= DB DEFAULT そのもの) を残すため、別経路 (raw SQL、直接 INSERT) を追加した時に再発リスク
  - 「lint がすり抜けたら本番で silent 混入」の保険が無い

### Alt-2: tenant_id を nullable + アプリ層で必須化
- 概要: schema で `tenantId String?` (nullable) として DEFAULT を外し、コード/route で必ず非 null 化
- メリット: migration はカラム制約変更のみ
- 不採用理由:
  - 既存の `where: { tenantId: viewerTenantId }` フィルタが nullable 化により tighten が崩れる
  - テナント越境防止に「`AND tenantId IS NOT NULL`」を全クエリに追加する負債が発生
  - データ整合性の意味的にもテナント所属を持たない業務エンティティは存在しない

### Alt-3: 全モデル統一の cross-cutting middleware で tenantId を自動注入
- 概要: Prisma の `$extends` / `client extensions` で `create` 系操作を hook し、AsyncLocalStorage から tenantId を自動セット
- メリット: コードベース全体で tenantId 引数の取り回しが不要になる
- 不採用理由:
  - AsyncLocalStorage が cron / batch / migration 経路では未セット → 結局 explicit fallback が必要
  - 暗黙挙動を別のレイヤに移動しただけで「何が起きているか追跡しにくい」問題は解消しない
  - PR 規模が大きくなり、severity-1 修正の緊急性と相反する

## Related (関連情報)

- 関連 PR: fix/tenant-id-default-removal-severity-1
- 関連 ADR:
  - [ADR-0001: マルチテナント基盤](./0001-multitenant-foundation.md) — 単一 tenant 運用期の暫定設計
  - [ADR-0016: マルチテナント ユーザ所属](./0016-multi-tenant-user-membership.md) — tenant-scoped email 一意化
  - [ADR-0018: テナント識別子のユーザ可視化](./0018-tenant-identifier-user-visibility.md)
- 関連 docs:
  - [docs/knowledge/KDD_PATTERNS.md §"tenant_id DB DEFAULT silent fallthrough"](../knowledge/KDD_PATTERNS.md)
  - [docs/design/SECURITY.md §"テナント分離検証"](../design/SECURITY.md)
  - [docs/operations/INCIDENT_RESPONSE.md §2026-05-28](../operations/INCIDENT_RESPONSE.md)
  - [docs/test/E2E_LESSONS.md](../test/E2E_LESSONS.md)
- 影響範囲:
  - schema: `prisma/schema.prisma` (13 model)
  - migration: `prisma/migrations/20260528_drop_tenant_id_default_severity_1/migration.sql`
  - code fix: `src/services/risk.service.ts`, `src/services/retrospective.service.ts`, `src/services/user.service.ts`, `src/services/error-log.service.ts`, `prisma/seed.ts`
  - data repair: `scripts/migrate-leaked-tenant-data.ts`

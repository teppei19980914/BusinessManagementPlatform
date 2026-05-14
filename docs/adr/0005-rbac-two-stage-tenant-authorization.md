# ADR-0005: RBAC + 二段階テナント認可 (Service 層で統一)

- **Status**: Accepted
- **Date**: 2026-04 (MVP 設計時、運用反復で改訂)
- **Deciders**: teppei

---

## Context

マルチテナント基盤 ([ADR-0001](./0001-multitenant-foundation.md)) を採用した上で、認可ロジックの実装方式を決める必要があった。
本サービスでは以下のロールが存在する:

- **super_admin**: テナント横断のシステム管理者 (テナント追加・削除、利用量モニタ等)
- **admin**: テナント内の管理者 (ユーザ管理、課金設定、テナント設定)
- **PM/TL**: プロジェクト管理者・チームリーダー (プロジェクト内の全権限)
- **member**: プロジェクトメンバー (タスク更新、ナレッジ登録)
- **viewer**: 閲覧者 (read only)

検討時の制約:

- **テナント越境は絶対防止**: severity-1 (個人情報漏洩相当) のリスク。事故では済まない
- **画面別 × 操作別の権限マトリクスが既に詳細に定義されている** ([docs/specification/PERMISSION_MATRIX.md](../specification/PERMISSION_MATRIX.md))
- **どの層で認可チェックするか**: Middleware / API ルート / Service 層 / DB のどれを「最後の砦」にするか
- **テスト容易性**: 認可ロジックがどこにあれば単体テストで網羅できるか
- **将来の Row Level Security (RLS) 導入余地**: 当面は採用しないが、将来選択肢として残したい

## Decision

**RBAC + 二段階認可、Service 層で統一チェック** を採用する。

### 二段階認可の構造

| 段階 | 何を検証するか | 実装層 |
|---|---|---|
| **第一段階: テナント境界** | ログインユーザの `tenantId` == リクエスト対象 entity の `tenantId` | Service 層 (一覧系: `viewerTenantId` を必須引数化、詳細系: `getById(id, viewerTenantId)` で where に強制) |
| **第二段階: ロール認可** | ユーザのロール (admin/PM/TL/member/viewer) でこの操作が許可されているか | Service 層 (`checkProjectPermission` / `requireAdmin` 等のヘルパー) |

### 各レイヤーの責任

- **Middleware**: 認証 (セッションの存在・有効性) のみ。認可はしない (理由: Edge runtime では DB を引けない、複雑な認可ロジックを Middleware に置くと変更時の影響範囲が広い)
- **API ルート (route.ts)**: 入力バリデーション (Zod) + Service 呼び出し。認可ロジックは持たない
- **Service 層**: 二段階認可を実施、業務ロジックを実装。**ここが認可の単一源**
- **DB (Prisma)**: RLS は採用しない (将来検討)

### super_admin の例外パス

テナント横断操作のため、第一段階のテナント境界チェックをスキップする例外パス。
ただし `super_admin` ロールの所持を別途検証し、監査ログに必ず記録する。

## Consequences

### Positive
- **認可ロジックの単一源**: Service 層に集中することで「どこを見れば認可が分かるか」が明確
- **単体テストで網羅可能**: Service 層をテストすれば認可マトリクスを再現できる
- **画面別権限マトリクスとの対応が取れる**: PERMISSION_MATRIX.md × Service 関数で表が組める
- **Middleware が軽量**: Edge runtime の制約 (DB 引けない) に違反しない
- **将来の RLS 導入時にも切替容易**: Service 層が認可の単一源のため、DB 側の RLS を段階導入できる

### Negative / Trade-off
- **`viewerTenantId` の引数化が boilerplate**: 一覧系 Service 関数すべてに `viewerTenantId: string` を強制する必要がある。新規 Service 追加時にうっかり省略すると越境バグになる
- **Service 関数の引数が増える**: `viewerTenantId` + `actorUserId` + `actorRole` 等の context 引数が常に必要
- **API ルートと Service の責任分担を理解する学習コスト**: 「API ルートに認可を書きそうになる」誤りが起きやすい

### Risk / 留意事項
- **`where.tenantId` 漏れの再発防止**: 新規一覧系 Service の追加時、コードレビューで必ず `viewerTenantId` の引数化と `where.tenantId` フィルタを確認する。漏れた場合は越境バグ (severity-1)
- **super_admin 操作は監査ログ必須**: 第一段階バイパスのため、監査ログでの追跡可能性が唯一の事後検知手段
- **2人目以降の開発者が来る前に、本パターンをドキュメント化しておくこと** (本 ADR + [docs/design/SECURITY.md](../design/SECURITY.md))
- **PHASE 2 で RLS 導入を検討する余地**: アプリ層バグでの越境を防ぐ二重防御のため ([docs/security/TENANT_ISOLATION_PHASE2_TODO.md](../security/TENANT_ISOLATION_PHASE2_TODO.md))

## Alternatives Considered

### Alt-1: Middleware で認可も行う
- 概要: Next.js Middleware で `tenantId` 検証とロール認可を完結
- メリット: API ルート/Service の boilerplate がなくなる
- 不採用理由: (1) Edge runtime では Prisma で DB を引けず、ユーザの最新ロールを参照できない (JWT claim でしか持てない) (2) Middleware は URL パターンマッチでしか分岐できず、操作種別 × エンティティ種別の複雑な認可マトリクスを表現しづらい

### Alt-2: PostgreSQL Row Level Security (RLS) で実装
- 概要: DB セッションに `tenant_id` を設定し、すべてのテーブルに RLS ポリシーを定義
- メリット: アプリ層のバグでテナント越境が起きない (DB が最後の砦)
- 不採用理由: (1) Prisma との相性が悪く、ORM 層での抽象化が難しい (2) AWS RDS 等への移行時に RLS の移植コスト (3) テスト容易性が低下 (DB セッションを毎テストで設定する必要) (4) v1 では Service 層認可で十分、PHASE 2 で二重防御として再検討

### Alt-3: 単一段階 (ロール認可のみ、テナント境界は DB クエリに任せる)
- 概要: ロール認可だけ実装し、テナント境界は呼び出し元責任
- メリット: シンプル
- 不採用理由: 越境バグが起きやすい。Service 関数の利用側 (API ルート、別 Service、cron 等) で `tenantId` フィルタを忘れた場合、即座に severity-1 事故になる

### Alt-4: API Gateway (Vercel Edge Middleware) で完全制御
- 概要: API ルートに辿り着く前に Edge で完全認可
- メリット: アプリケーションコードから認可を分離
- 不採用理由: Alt-1 と同様の Edge 制約。さらに認可ロジックが「コード」ではなく「設定」に近づき、テスト・デバッグが困難

## Related

- 詳細設計: [docs/design/SECURITY.md](../design/SECURITY.md) §8
- 権限マトリクス: [docs/specification/PERMISSION_MATRIX.md](../specification/PERMISSION_MATRIX.md)
- ユーザロール定義: [docs/business/USER_ROLES.md](../business/USER_ROLES.md)
- マルチテナント基盤: [ADR-0001](./0001-multitenant-foundation.md)
- 越境防止の運用ルール: memory `feedback_tenant_isolation` (一覧系サービスは `viewerTenantId` 必須)
- 次フェーズ (RLS 導入検討): [docs/security/TENANT_ISOLATION_PHASE2_TODO.md](../security/TENANT_ISOLATION_PHASE2_TODO.md)

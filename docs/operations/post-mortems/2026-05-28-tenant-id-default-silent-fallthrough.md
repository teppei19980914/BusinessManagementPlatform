# Post-mortem: tenant_id DB DEFAULT による silent テナント越境バグ

- **日付**: 2026-05-28
- **重大度**: S-1 (個人情報漏洩リスク)
- **対応者**: teppei
- **影響時間**: 2026-04-15 (PR #2 投入) 〜 2026-05-28 (本 PR デプロイまで)
- **影響範囲**: 全 RiskIssue / Retrospective 作成経路。非 Default テナントの起票が Default テナントに混入

---

## サマリ (3 行以内)

`schema.prisma` の `tenantId @default(dbgenerated tenantId)` に依存して `createRisk` / `createRetrospective` が data に tenantId を渡し忘れていたため、全テナントの課題/振り返り起票が silent に Default テナントに保存され、起票者本人の一覧から消える + Default テナントに他テナントデータが混入していた。

## タイムライン

| 時刻 | 出来事 |
|---|---|
| 2026-04-15 | PR #2 (T-03) で `tenantId @default(dbgenerated)` を schema に導入 (単一テナント期の暫定設計) |
| 2026-05-14 | PR feat/asset-multi-project-linking で createRisk / createRetrospective をリファクタした際、`data.tenantId` の書き直し漏れが発生 |
| 2026-05-28 早朝 | testテナントの一般ユーザが課題を起票して「一覧に出ない」事象を報告 |
| 2026-05-28 朝 | 全コードスキャン調査開始 |
| 2026-05-28 昼 | 根本原因 (`createRisk` / `createRetrospective` の data に tenantId 欠落 + schema DB DEFAULT) を特定 |
| 2026-05-28 昼 | ADR-0024 ドラフト + 13 モデルから DB DEFAULT 撤去 + データ修復スクリプト作成 |
| 2026-05-28 夕 | PR fix/tenant-id-default-removal-severity-1 で全フェーズ修正完了 |

## 影響

- **ユーザ影響**: 起票者は「課題がありません」表示で実質的に機能不全。気付かず諦めた可能性のあるユーザがいた可能性
- **データ影響**:
  - 全 RiskIssue / Retrospective レコードのうち、起票者が Default 以外のテナントに所属しているものが Default テナントに混入
  - 既存データの修復は `scripts/migrate-leaked-tenant-data.ts` (DRY_RUN → `--apply`) で実施
- **金銭影響**: なし (LLM 課金は別途 ApiCallLog で記録されており、影響なし)
- **個人情報漏洩**:
  - Default テナント側の「全リスク/全課題」横断ビューは `visibility='public'` のみ表示するため、`draft` で起票されたものは直ちには露出していない
  - ただし `draft` → `public` に変更したケースは Default テナント側に露出する状態になっていた

## 直接原因 (Direct Cause)

```typescript
// src/services/risk.service.ts:460 (修正前)
const r = await prisma.riskIssue.create({
  data: {
    projectId,
    // ❌ tenantId が無い (引数で受けているのに data に渡していない)
    type: input.type,
    // ...
  },
});
```

schema 側で:
```prisma
tenantId String @default(dbgenerated("'00000000-0000-0000-0000-000000000001'::uuid"))
```
の DB DEFAULT があったため、Prisma は tenantId 未指定でもエラーを投げず、Default テナント (`00000000-...-001`) を自動セットしていた。

## 根本原因 (Root Cause)

1. **schema 設計の暫定設計が長期化**: PR #2 (2026-04-15) で「単一 tenant 運用期の暫定」として導入した DB DEFAULT が、マルチテナント本格化後も撤去されないまま約 6 週間運用された
2. **Prisma の型推論の盲点**: `@default(dbgenerated)` を持つカラムは TypeScript で optional 扱いになるため、`data` に tenantId を書き忘れても `tsc` は通る (silent 挙動)
3. **コードレビュー観点漏れ**: `prisma.X.create({ data })` の差分レビュー時に「data に tenantId があるか」のチェック項目が定式化されていなかった
4. **E2E テストの盲点**: 既存の `e2e/specs/11-tenant-isolation.spec.ts` は **fixture が生 SQL で tenantId を明示挿入** していたため、サービス層 create のバグを exercise していなかった
5. **マルチテナント検証の不足**: 開発フェーズで Default テナントのみで検証していたため、Default 以外のテナントで起票したらどうなるかを E2E で確認していなかった

## 良かったこと

- 一般ユーザ視点での実機検証で早期発見 (PR 単位レビューでは検知できなかった可能性が高い)
- 全コードスキャンの体制 ([[feedback_repeated_verification_request]]) で根本原因を当日中に特定できた
- 修復スクリプトを DRY_RUN モードでデフォルト動作させ、ユーザ確認後に `--apply` する安全策を組込めた
- ADR-0024 として「DB DEFAULT 撤去 → コード明示必須化」の設計判断を文書化し、再発防止と将来の新規モデルへの適用ガイドにできた

## 改善すべきこと (Action Items)

| # | アクション | 担当 | 期限 | 関連 PR/Issue |
|---|---|---|---|---|
| 1 | schema の DB DEFAULT 撤去 (13 モデル) + migration 適用 | teppei | 2026-05-28 | fix/tenant-id-default-removal-severity-1 |
| 2 | `createRisk` / `createRetrospective` / `createUser` の code fix + tests | teppei | 2026-05-28 | 同上 |
| 3 | データ修復スクリプト (`scripts/migrate-leaked-tenant-data.ts`) の DRY_RUN 実行 → 結果確認 → `--apply` | teppei | 2026-05-29 | 同上 |
| 4 | E2E regression test 追加 (Tenant A 起票 → A 自身が見える) | teppei | 2026-05-28 | 同上 |
| 5 | コードレビューチェックリストに「`prisma.X.create` の data に tenantId 必須」を追加 | teppei | 2026-06-01 | CONTRIBUTING.md 更新 |
| 6 | 監視: テナント別 RiskIssue 件数の日次レポート (Default テナントへの再度の混入を即時検知) | teppei | 2026-06-15 | future |
| 7 | 一般ユーザでの E2E テスト経路を強化 (非 Default テナントで全業務操作を確認) | teppei | 2026-06-15 | future |

## 関連

- 修正 PR: fix/tenant-id-default-removal-severity-1
- 関連 ADR: [ADR-0024: tenant_id カラムから DB DEFAULT を撤去](../../adr/0024-explicit-tenant-id-no-db-default.md)
- KDD: [docs/knowledge/KDD_PATTERNS.md §5.X+169](../../knowledge/KDD_PATTERNS.md)
- SECURITY: [docs/design/SECURITY.md §26 テナント分離検証](../../design/SECURITY.md)
- memory: [feedback_db_default_tenant_silent_fallthrough](../../../memory/feedback_db_default_tenant_silent_fallthrough.md)

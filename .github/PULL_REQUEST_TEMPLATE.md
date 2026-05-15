<!--
  PR テンプレート
  本テンプレートは PR 作成時に自動挿入されます。以下のセクションを記入してください。
  各セクションの HTML コメントは削除して構いません (見出しは残す)。
-->

## 概要

<!-- この PR が何を解決するか 1-3 行で。「〜の実装」「〜のバグ修正」等。 -->

## 変更内容

<!-- 箇条書きで具体的な変更点。ファイル名や関数名を挙げると review しやすい。 -->

- 

## 関連 Issue / 設計書

<!-- 該当する場合のみ。なければ削除。 -->

- Closes #
- 設計参照: [docs/design/](../docs/design/) (ARCHITECTURE / DATA_MODEL / API_DESIGN / SECURITY / INFRASTRUCTURE / SUGGESTION_ENGINE / UI_PATTERNS 等)
- 業務ロジック: [docs/business/](../docs/business/) / 画面仕様: [docs/specification/](../docs/specification/)
- 設計判断: 後戻りコストが高い変更なら [docs/adr/](../docs/adr/) に ADR 追加を検討

## 検証内容

<!-- 動作確認した内容。チェックボックスで埋める形。 -->

- [ ] `pnpm lint` 通過
- [ ] `pnpm tsc --noEmit` 通過
- [ ] `pnpm test` 通過 (テスト数: 増減あれば記入)
- [ ] `pnpm build` 通過
- [ ] E2E が関係する変更は `pnpm e2e:coverage-check` 通過
- [ ] 動作確認済み (happy path + 主要な異常系 1-2 パターン)

## コミット前チェックリスト ([CLAUDE.md](../CLAUDE.md)「コミット前チェック」 / [CONTRIBUTING.md §1](../CONTRIBUTING.md) より)

- [ ] **横展開**: 同一パターンが他ファイルに残っていないか `grep` で確認済み
- [ ] **退行 (リグレッション)**: テスト数の増減・旧文言残留・E2E カバレッジへの新規 page/route 追記漏れがないか
- [ ] **テナント越境防止** (一覧系サービス追加時): `viewerTenantId` を必須引数化し `where.tenantId` フィルタを強制 ([ADR-0001](../docs/adr/0001-multitenant-foundation.md) / [ADR-0005](../docs/adr/0005-rbac-two-stage-tenant-authorization.md))
- [ ] **セキュリティ**: ユーザ入力サニタイズ / 生 SQL / 機密情報ハードコード無し
- [ ] **設計原則**: 業務的意味を持つ値のハードコード無し (色 / 文字数上限 / パス / 認証定数等は `src/config/` 経由)
- [ ] **ドキュメント更新**: 仕様変更なら関連 md ([docs/specification/](../docs/specification/) / [docs/design/](../docs/design/) / [docs/operations/](../docs/operations/) / [docs/developer-guide/](../docs/developer-guide/)) 更新済み

## レビュアへのメモ

<!-- レビュー時に特に見てほしい点・背景情報・議論したい箇所があれば。 -->

## スクリーンショット (UI 変更時)

<!-- 該当する場合のみ。Before / After の 2 枚を並べると review しやすい。 -->

---

<!-- 自動マージ希望の場合、PR 作成後にドロップダウンから "Enable auto-merge (squash)" を選択してください。 -->

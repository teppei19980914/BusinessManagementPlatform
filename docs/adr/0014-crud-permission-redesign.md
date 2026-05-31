# ADR-0014: CRUD 設計刷新 — UI=API 認可一致原則 + PM/TL 自律権限 + 自己ロール変更禁止 (2026-05-20)

- **Status**: Accepted
- **Date**: 2026-05-20
- **Deciders**: teppei

---

## Context

2026-05-20 にユーザ要件として「CRUD 設計の全体的な見直し」が入った。背景として、過去 2 巡のフルスキャン検証 (main ベース) において、UI と API の認可境界に 20 件以上の severity-1 / severity-2 級ギャップが検出されていた。
具体的には、UI 上は admin だけが操作可能に見えるエンドポイントが API としては member / viewer からも到達可能 (権限チェック漏れ)、あるいは UI 上は経路が存在しないが API としては横断 PATCH で他テナントに影響を及ぼせる、といった構造的なほつれが点在していた。

これらは個別 fix では再発するため、**設計レベルで「UI=API 認可一致」を原則化** し、関連する 6 つの設計判断を 1 つの PR (#416 / `feat/crud-permission-redesign`) に集約して対応する必要があった。

検討時の制約・前提:

- **テナント越境防止が最優先** (severity-1 個人情報漏洩リスク。MEMORY 参照)
- **PM/TL の自律性向上**: メンバー追加 / 役割変更を admin に毎回依頼する運用は MVP リリース初期のフィードバックで負担と判明
- **監査ログ完全性 (ADR-0011)** を崩さない: 厳格化に伴う追加チェックも全て監査ログに記録する
- **既存テナントへの影響を最小化**: 機能追加 + 厳格化のみとし、data migration を避ける
- **E2E カバレッジ (CONTRIBUTING.md / pnpm e2e:coverage-check)** を含む既存テスト群を新仕様に揃え直す

「決めないと先に進めない」最大の理由は、後続機能 (提案エンジン拡張、見積タブ強化) が PM/TL の権限境界を前提に設計されており、認可の根幹を固めずに進めると複数の rebase 衝突と仕様矛盾が連鎖するためである。

## Decision

PR #416 にて以下の 6 つの主要設計判断を採択する。

### (1) UI=API 認可一致原則

UI からアクセスできない経路は API としても 403 (または 405) を返す。
代表例として、横断 PATCH ハンドラ (UI に対応経路が存在しないもの) は **ハンドラ自体を削除** し 405 Method Not Allowed を返すよう変更した。これにより「UI に存在しないので OK」という暗黙仮定を排除し、API 単体の認可テストでも安全性が成立するようにする。

### (2) PM/TL のメンバー管理開放 + 細粒度ガード

PM / TL に `member:manage` 権限を開放する。ただし「PM / TL ロール自体を扱う操作」 (PM/TL の追加・降格・昇格) は admin only とし、PM/TL が PM/TL を操作しようとした場合は `FORBIDDEN_PMTL_ROLE` で拒否する。
member / viewer の追加・降格・削除は PM/TL が自律的に実行可能。

### (3) 削除 API の経路別認可 (context 引数)

削除 service 関数に `context: 'project' | 'cross'` 引数を必須化する。

- `context: 'project'` 経路: 作成者本人のみ削除可
- `context: 'cross'` (admin 横断管理画面など) 経路: admin のみ削除可

route ファイル分離だけでは service 直接呼び出しで context が抜け落ちる事故が起きうるため、**service 層で context を強制** する設計とした。

### (4) 参考タブ + 見積タブを PM/TL + admin 限定

参考タブ / 見積タブの参照・編集 API は `project:update` 認可で統一する。これにより member / viewer から API 直叩きしても 403 が返る。UI 側でもタブ自体を非表示にして UI=API 認可一致原則を満たす。

### (5) 全メモ画面で admin の public モデレーション削除特権

public 可視性のメモは admin によるモデレーション削除を可能とする (不適切投稿対応)。ただし private 可視性のメモは admin であっても削除不可とし、プライバシー保護を優先する。

### (6) 自己ロール変更禁止

自分自身のロールを変更する経路を 3 つすべて塞ぐ:

- **admin / users 管理画面**: `CANNOT_CHANGE_OWN_ROLE`
- **プロジェクトメンバー管理**: `CANNOT_CHANGE_OWN_PROJECT_ROLE`
- **super_admin への昇格 UI**: そもそも UI 非表示 (自己昇格経路を物理的に作らない)

これにより「admin が誤って自分を member に降格 → テナント管理者不在」のロックアウト事故と「PM が自分を admin に昇格」の特権昇格を同時に防ぐ。

## Consequences

### Positive
- **認可境界の構造的明確化**: UI=API 一致原則により「UI に経路がない = API も安全」の暗黙仮定を排除
- **横展開漏洩防止**: 削除 service の context 引数強制により、新規 route 追加時に認可漏れが service 層で必ず引っかかる
- **監査証跡完全性の維持**: 厳格化された権限チェックも全て監査ログに記録、ADR-0011 の WORM 性は維持
- **PM/TL の自律性向上**: メンバー追加 / 降格を admin に依頼せず実行可能となり、運用負荷軽減
- **ロックアウト事故予防**: 自己ロール変更禁止により、admin 不在による顧客テナントの管理不能事故を構造的に排除
- **プライバシー保護**: private メモは admin にも開示しない明示ポリシーが文書化された

### Negative / Trade-off
- **API シグネチャ変更**: 削除 service に `actorSystemRole`, `context` 引数追加。既存呼出箇所の更新が必要
- **UI レイヤの prop 追加**: `currentUserId`, `canManagePmTl` などの prop を権限境界に近いコンポーネントへ伝播する必要がある (prop drilling)
- **E2E test の期待値変更**: 横断 PATCH knowledge は 405 を返すよう変更されたため、既存 E2E spec の期待値更新が必要 (KDD §5.X+85)
- **PM/TL ロールガード文言の追加**: `FORBIDDEN_PMTL_ROLE`, `CANNOT_CHANGE_OWN_ROLE`, `CANNOT_CHANGE_OWN_PROJECT_ROLE` 等の i18n 文言を新規追加

### Risk / 留意事項
- **Knowledge per-link gate 非対称**: 一部の knowledge リンク経由参照で gate が非対称な箇所が残存 ([FOLLOW_UP_AFTER_PR416.md](../archive/2026-06-01-pre-ops-reorg/FOLLOW_UP_AFTER_PR416.md) で追跡)
- **suggestion sourceProjectName 漏洩**: 提案エンジン応答に閲覧不可プロジェクト名が含まれるケースが残存 (同上、フォローアップ予定)
- **context 引数の付け忘れ**: 新規 route 追加時に service を呼ぶ際 context を渡し忘れると TypeScript で検知できるが、呼び出し側の判断ミス (例: `'project'` を渡すべきところに `'cross'`) は静的検知不可。コードレビューで担保

## Alternatives Considered

### Alt-A: 全 cascade を 1 大規模 transaction で実施
- 概要: 削除 / 権限変更 + 関連監査ログ + 関連 entity の cascade 更新を全て 1 transaction にまとめる
- メリット: 原子性が DB 層で保証される
- 不採用理由: テナント横断データを含む cascade では transaction の timeout が過大になりやすく、Supabase の statement timeout 制限に抵触する見込み。MVP 段階の安全性を損なう

### Alt-B: 段階別 transaction + 冪等設計 (採択)
- 概要: 関連処理を意味単位の小 transaction に分割し、各処理を冪等にしてリトライ可能にする
- メリット: 個別 transaction が短く失敗時のリトライ容易。timeout リスクが小さい
- 採択

### Alt-C: 削除 API を context 引数なしで route のみ分離
- 概要: `/api/projects/:id/.../route.ts` と `/api/admin/.../route.ts` の route 分離だけで認可を表現し、service 関数は共通利用
- メリット: 引数追加なしで route ファイルだけで境界が表現できる
- 不採用理由: route を経由せず service を直接呼ぶ箇所 (cron / 内部 worker / 他 service からの利用) で context が消失する。**service 層で context を強制** する案 (採択案) の方が漏洩防止に強い

## Migration Notes

- **既存テナントへの影響**: なし。機能追加 + 厳格化のみで、既存データの書き換えは不要
- **data migration**: 不要
- **API クライアント (E2E test) への影響**: 横断 PATCH knowledge は 405 を返すよう変更 (KDD §5.X+85 参照)。該当 E2E spec は PR #416 内で同時更新済
- **アプリケーション側の対応**: 削除 service を呼ぶ全箇所に `actorSystemRole` / `context` を追加 (TypeScript 型エラーで検知可能)
- **UI 側の対応**: PM/TL メンバー管理画面に `canManagePmTl` prop 追加、自己ロール変更 UI 非表示化 (`currentUserId` prop)

## Related

- **PR #416**: https://github.com/teppei19980914/BusinessManagementPlatform/pull/416
- **関連 ADR**:
  - [ADR-0005](./0005-rbac-two-stage-tenant-authorization.md) (RBAC 二段階テナント認可)
  - [ADR-0011](./0011-soft-delete-and-audit-log.md) (論理削除 + 監査ログ完全記録)
- **関連 KDD**:
  - §5.X+85: UI=API ハンドラ削除と E2E 期待値 (405 化)
  - §5.X+86: security-check コメント文字列
  - §5.X+87 / §5.X+88: CodeQL prototype pollution
- **影響ファイル (仕様文書)**:
  - [docs/specification/PERMISSION_MATRIX.md §7.X](../specification/PERMISSION_MATRIX.md)
  - [docs/business/USER_ROLES.md §6.6](../business/USER_ROLES.md)
- **フォローアップ**: [FOLLOW_UP_AFTER_PR416.md](../archive/2026-06-01-pre-ops-reorg/FOLLOW_UP_AFTER_PR416.md) (Knowledge per-link gate 非対称, suggestion sourceProjectName 漏洩)

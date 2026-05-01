# business/ — ビジネスロジック文書

本ディレクトリは、本サービスの業務ルール・運用フロー・課金モデルなど **ビジネスロジックの中核** を集約する。技術的な実装は [../design/](../design/)、画面の操作仕様は [../specification/](../specification/) を参照。

## ファイル一覧

| ファイル | 内容 | 元の所在 |
|---|---|---|
| [PROJECT_LIFECYCLE.md](./PROJECT_LIFECYCLE.md) | プロジェクト状態定義・状態ごとの操作制限・ロック条件・アカウントライフサイクル | SPECIFICATION.md §2-§3, §8-§10, §10.7, §13 |
| [TENANT_AND_BILLING.md](./TENANT_AND_BILLING.md) | マルチテナント運用フロー・3 プラン構成 (Beginner/Expert/Pro)・per-API-call 従量課金・月次予算上限 | DESIGN.md §34.11-§34.14 + REQUIREMENTS.md §13.6-§13.7 + SPECIFICATION.md §26.6-§26.7 |
| [USER_ROLES.md](./USER_ROLES.md) | システムロール (admin / general)・プロジェクトロール (pm_tl / member / viewer) の定義と権限制御方針 | SPECIFICATION.md §6 |
| [MVP_SCOPE.md](./MVP_SCOPE.md) | MVP 必須機能一覧・対象外機能・管理項目一覧・要件定義全体 | REQUIREMENTS.md §1-§12 + SPECIFICATION.md §4-§5 |

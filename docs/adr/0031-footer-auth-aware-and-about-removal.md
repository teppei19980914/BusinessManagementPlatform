# ADR-0031: フッター認証出し分け + `/settings/about` 廃止 + 共通情報の LP 集約

- Status: Accepted (2026-05-31)
- 関連: [ADR-0018](./0018-tenant-identifier-user-visibility.md) (設定画面の情報分離) / [vision/README.md §4](../vision/README.md) (情報最小化・引き算の哲学)
- 実装: `feat/footer-auth-aware-links` (2026-05-31)

## Context (背景)

全画面共通フッタは初版 (`feat/app-version-changelog-footer` 2026-05-23) → 統合 (`feat/app-header-footer-unification` 2026-05-24) を経て、以下の構成だった:

- フッタに「サービス情報 (`/settings/about`) / お知らせ (`/announcements`)」の 2 リンク + 3 段目に **copyright (© 年 たすきば運営) + 最終更新日**。
- `/settings/about` 画面に「サービス名 / バージョン / 更新履歴 / 運営者情報 / 規約・プライバシーリンク」を集約。

この構成には次の問題があった:

1. **二重管理**: 運営者情報・規約・プライバシーは外部 LP (tasukiba-user ページ) にも存在し、サービス内 (`/settings/about`) と二重に持っていた。法的書面・運営者情報の改定時に 2 箇所更新が必要で drift の温床。
2. **未ログイン時の情報露出**: ログイン / MFA 画面でも「最終更新日」等の運用情報やセキュリティ報告経路が見えるべきかは疑問。未ログイン状態では「サービスの素性 (法定・運営情報)」だけ確認できれば十分。
3. **情報過多**: vision §4「引き算の美学 / あるべきでないものは置かない」に照らし、copyright・最終更新日は健全運営シグナルのつもりが冗長。バージョン情報はログイン後のアカウントメニューにあれば足りる。

## Decision (決定)

フッタを **認証状態で 2 層に出し分け**、共通情報は外部 LP を単一真値とする:

1. **共通情報 (ログイン前後で常時表示)** — すべて外部 LP (`tasukiba-user` ページ) の各アンカーへ集約 (`target="_blank"`):
   - 製品ページ (`PRODUCT_USER_PAGE_URL` = LP base) / 利用規約 (`#terms`) / プライバシーポリシー (`#privacy`) / 運営者情報 (`#operator-info`) / 特定商取引法に基づく表記 (`#tokushoho`)
   - URL 定数は [`src/config/legal-versions.ts`](../../src/config/legal-versions.ts) に集約。
2. **ログイン後限定情報 (`isAuthenticated` のときだけ追加表示)**:
   - お知らせ (アプリ内 `/announcements`、`next/link`) / セキュリティ報告 (LP `#security`)
   - 認証判定は root layout が `auth()` で解決し prop で渡す。MFA 未検証 (`mfaVerified=false`) は `false` 扱い = 共通情報のみ。
3. **廃止**: copyright (© 年 たすきば運営) / 最終更新日 / 「サービス情報」(`/settings/about` リンク)。
4. **移設**: バージョン / 更新履歴 → ヘッダ右上 AccountMenu「バージョンアップ情報」(→ アプリ内 `/changelog`、ログイン後のみ到達可能)。
5. **ページ廃止**: `/settings/about` を page ごと削除 (移設先がすべて確定し役割消失)。

## Consequences (結果)

- 法的書面・運営者情報の真値が **LP 単一**になり、二重管理 drift が解消。
- 未ログイン画面のフッタは法定・運営情報のみに最小化。運用情報 (お知らせ・セキュリティ報告) はログイン後のみ。
- `src/config/operator.ts` (`OPERATOR_NAME` / `OPERATOR_LABEL` / `SECURITY_ADVISORY_URL`) はフッタからは**未参照化**。運営者情報の単一真値ファイルとして温存 (削除しない)。
- バージョン確認動線が「フッタ常時」から「AccountMenu (ログイン後)」に変わる。未ログインでのバージョン確認はできなくなるが、素性確認は LP で代替。
- リリース時の真値更新フローが変化: フッタは version / date / copyright を描画しなくなるため、`package.json` version・`NEXT_PUBLIC_RELEASE_DATE` はフッタ表示には影響せず `/changelog` 等にのみ反映 ([operations/develop/RELEASE_PROCEDURE.md](../operations/develop/RELEASE_PROCEDURE.md) を本 ADR に合わせ更新済)。

## Alternatives considered (検討した代替案)

- **`/settings/about` を残し情報集約だけ続ける**: 二重管理が解消しない。LP を正とする方針 (ADR-0018 の情報分離思想) と不整合。不採用。
- **フッタに全情報を常時表示 (認証出し分けなし)**: 未ログイン画面に運用情報・報告経路が露出。情報最小化方針に反するため不採用。
- **バージョンをフッタに残す**: 常時表示の必要性が低く、AccountMenu で十分。引き算の美学に沿って移設。

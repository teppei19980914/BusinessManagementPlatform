# 引き継ぎ: フッタ認証出し分け改修 (feat/footer-auth-aware-links)

> 作成: 2026-05-31 / 本セッション = **ソースコード修正のみ** 担当。
> Session A (DB 料金体系ロジック) / Session B (docs 整理) と並行作業のため、本メモは
> **Session B へ docs 最新化を引き継ぐ** ことが目的。コミット/プッシュ/PR は未実施。

---

## 1. 何を変えたか (ユーザ要望)

フッタを「情報最小化ポリシー + 二重管理防止」の観点で **認証状態により 2 層に出し分け** た。

- **共通情報** (ログイン前後で常時表示) — すべて外部 LP (tasukiba-user ページ) のアンカーへ集約:
  製品ページ / 利用規約 / プライバシーポリシー / 運営者情報 / 特定商取引法に基づく表記
- **ログイン後限定情報** (`isAuthenticated` のときだけ追加):
  お知らせ (アプリ内 `/announcements`) / セキュリティ報告 (LP `#security`)
- **廃止**: 「© 2026 たすきば運営」(copyright) / 「最終更新: 2026-06-01」(lastUpdated) / 「サービス情報」(`/settings/about`)
- **移設**: バージョン/更新履歴 → ヘッダ右上 AccountMenu の「バージョンアップ情報」(→ アプリ内 `/changelog`)
- **ページ廃止**: `/settings/about` はすべての情報の移設先が決まり役割を失ったため削除

---

## 2. 変更ファイル一覧 (本セッションの作業ツリー差分)

### BMP (このリポジトリ) src
| ファイル | 変更 |
|---|---|
| `src/components/app-footer.tsx` | 2 層構成へ全面再構築。`isAuthenticated` prop 追加。共通リンクは `@/config/legal-versions` 定数経由 |
| `src/components/app-footer.test.tsx` | source-pattern invariant を新仕様へ刷新 (12 tests) |
| `src/app/layout.tsx` | `auth()` から `isAuthenticated` を算出 (session.user 存在 & MFA 未検証中間状態でない) し footer へ渡す |
| `src/components/app-header.tsx` | AccountMenu に「バージョンアップ情報」(→`/changelog`, testid=`account-menu-version-info`) 追加 |
| `src/config/legal-versions.ts` | `PRODUCT_USER_PAGE_URL` / `OPERATOR_INFO_URL` / `TOKUSHOHO_URL` / `SECURITY_REPORT_URL` を追加 |
| `src/i18n/messages/ja.json` / `en-US.json` | `footer` キー刷新 (navLabel/productPage/terms/privacy/operatorInfo/tokushoho/announcements/securityReport)。`about` namespace 削除。`nav.versionInfo` 追加 |
| `src/app/(dashboard)/settings/settings-client.tsx` | 「サービス情報 →」リンク + `Link` import 撤去 |
| `src/app/(dashboard)/settings/about/page.tsx` | **削除** (ページごと廃止) |
| `e2e/specs/15-version-and-announcements.spec.ts` | `/settings/about` テスト削除 + フッタ認証出し分け smoke 追加 |
| `docs/test/E2E_COVERAGE.md` | `/settings/about` 行を削除 (CI ゲート密結合のため本セッションで対応) |

### HomePage (別リポジトリ `C:\Users\SF02512\GitHub\Private\HomePage`)
| ファイル | 変更 |
|---|---|
| `src/content/product/ja/tasukiba-user.md` | `#security` セクション (運営者情報/特商法の隣) 新設 + GitHub advisories リンク。既存「脆弱性のご報告」文に `#security` への内部リンク追記 |
| `src/content/product/en/tasukiba-user.md` | 同上 (英語版) |

---

## 3. 品質ゲート結果 (全 green)

| ゲート | 結果 |
|---|---|
| `pnpm lint` | EXIT 0 (warnings 23 件はすべて既存、新規なし) |
| `pnpm tsc --noEmit` | EXIT 0 |
| `pnpm test` | EXIT 0 (3834 tests / 240 files passed) |
| `pnpm e2e:coverage-check` | ✅ 画面 49 / API 142 全記載 |
| `pnpm build` | EXIT 0 (`/settings/about` がルート一覧から消えたことを確認) |

---

## 4. Session B (docs 最新化) へお願いしたい更新

本セッションは `docs/test/E2E_COVERAGE.md` のみ更新済 (CI 密結合のため)。以下は **散文 docs** のため Session B 領域:

- [ ] `docs/specification/SCREENS.md` — `/settings/about` 画面の記述を削除。フッタの構成 (共通/ログイン後限定) を更新
- [ ] `docs/specification/UI_RULES.md` / `docs/design/UI_PATTERNS.md` — フッタ仕様 (旧: copyright+最終更新+サービス情報/お知らせ → 新: 認証出し分け 2 層) を更新
- [ ] `docs/design/SECURITY.md` — セキュリティ報告導線が LP `#security` に集約された旨を追記 (任意)
- [ ] 既存 ADR or 新規 ADR — 「フッタ認証出し分け + `/settings/about` 廃止 + LP 集約」の設計判断を記録 (要否は Session B 判断)
- [ ] `docs/operations/operate/INCIDENT_RESPONSE.md` 等でセキュリティ報告窓口に言及があれば LP `#security` へ統一

> 注意: `src/config/operator.ts` の `OPERATOR_NAME` / `OPERATOR_LABEL` / `SECURITY_ADVISORY_URL` は
> 本改修で未使用化したが、運営情報の単一真値ファイルであり将来再利用余地があるため **温存** した
> (lint/build に影響なし)。docs で「これらは現状未参照」と注記するかは Session B 判断。

---

## 5. 設計判断メモ (レビュー用)

- **認証判定**: `layout.tsx` で `!!session?.user && !(mfaEnabled && !mfaVerified)`。MFA 検証前の中間状態は
  (auth) layout が user=null 扱いにするのと同思想で「共通情報のみ」表示。
- **二重管理防止**: 共通情報は LP の単一真値 (`LEGAL_DOC_BASE_URL` = tasukiba-user) アンカーへ集約。
  サービス内に運営者情報/規約のコピーを持たない。
- **セキュリティ観点**: 未ログイン画面 (login/MFA) では運用情報 (お知らせ) と報告経路 (セキュリティ報告) を
  前面に出さない。共通情報は法定・運営の最小限のみ。認証バイパスとは無関係 (middleware で別途強制)。

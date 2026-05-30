#!/usr/bin/env bash
# Netlify build wrapper
#
# 役割: `pnpm build:netlify` (= prisma generate + migrate deploy + next build) を実行する
#       薄いラッパー。本ファイルが存在することで netlify-ignore.sh の path-based skip が
#       「scripts/ 配下の変更」として検出され、env var 変更等で再 build を発火させる
#       手段にも使える (= 空コミットではトリガーされないため、本ファイル末尾コメント等の
#       1 行追加で確実に rebuild を起こせる)。
#
# ============================================================================
# ★重要★ 2026-05-22 (PR #425, KDD §5.X+101): 過去の NEXTAUTH_URL inject 削除済み
# ============================================================================
#   旧版 (2026-05-21 PR #425 初版) では以下を実行していた:
#     export NEXTAUTH_URL="${URL:-${NEXTAUTH_URL:-https://tasukiba.netlify.app}}"
#
#   意図: Netlify が build 時に自動設定する `URL` env var (= deploy context に応じて変化)
#         を NEXTAUTH_URL に注入し、Deploy Preview から本番 URL へのリダイレクト事象を防ぐ。
#
#   結果: ★実質効果なし★。Next.js は `NEXT_PUBLIC_*` 以外の server-side env var を
#         build 時に bundle へ焼き込まないため、build wrapper 内の `export` は
#         Netlify Function runtime (= 別 Lambda 実行環境) には一切伝播しない。
#         Function runtime での `process.env.NEXTAUTH_URL` は Netlify Dashboard で
#         設定された値 (全 scope 共通の本番 URL) が読まれ続けていた。
#
#   真の根本解決 (KDD §5.X+101): Netlify Dashboard で NEXTAUTH_URL を context override
#     - Production:       https://tasukiba.com (固定値、2026-05-29 独自ドメイン移行)
#     - Deploy preview:   未設定 (= NextAuth が trustHost: true で host header を使用)
#     - Branch deploys:   未設定 (= 同上)
#     操作手順は KDD §5.X+101 「解決策」セクション参照。
#
#   ★再発防止★ 本 build wrapper に NEXTAUTH_URL や類似 env var の `export` を再追加しない。
#               同じ罠を踏みかける。runtime に env var を伝えたければ Netlify Dashboard で
#               context-specific 設定を使う。それ以外の選択肢は存在しない。
# ============================================================================

set -euo pipefail

# CONTEXT / URL は Netlify build 環境で確認用に出力 (どちらも build 時のみ有効)
echo "[netlify-build] CONTEXT=${CONTEXT:-unknown} URL=${URL:-unset}"

# ================================================================
# 2026-05-26 (PR #448, KDD §5.X+152): orphan failed migration の自動解消 (★解消済 / 撤去★)
# ================================================================
# 経緯:
#   PR #448 で migration `20260529_risk_issue_occurrence` が syntax error で fail し、
#   production Supabase DB の `_prisma_migrations` に failed entry が残った。
#   hotfix として毎 deploy で `prisma migrate resolve --rolled-back` を試行していた。
#
# 撤去 (PR #471 / 2026-05-30):
#   production DB で orphan は解消済 (ユーザ報告: deploy 毎に P3011 "never applied"
#   = orphan entry はもう存在しない)。hotfix を残しておくと毎 deploy で P3011 エラー
#   ログが noisy に出続けるため撤去する。
#
#   万一 staging / 別環境で同じ orphan が再発した場合は git history から本 block を
#   復活させて 1 度だけ実行すれば良い (Prisma 公式の hotfix 手順そのもの)。
#
# 関連: KDD §5.X+152 (本件の前駆 KDD)

# build:netlify (= prisma generate + migrate deploy + faq embedding 自動生成 + next build) を実行
exec pnpm build:netlify

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
# 2026-05-26 (PR #448, KDD §5.X+152): orphan failed migration の自動解消
# ================================================================
# 経緯:
#   PR #448 初回 push 時、prisma/migrations/20260529_risk_issue_occurrence/migration.sql に
#   table 名 typo (`risk_issues` → 正しくは `risks_issues`) があり、Netlify build の
#   `prisma migrate deploy` で P3018 fail。その結果、production Supabase DB の
#   `_prisma_migrations` テーブルに「failed 状態の旧 entry」が残った。
#
#   SQL fix + migration rename (20260530_risk_issue_occurrence_retry) で対処したが、
#   Prisma の `migrate deploy` は **failed entry が 1 つでもあれば** P3009 で全ての
#   後続 migration を block する仕様のため、orphan entry が消えるまで deploy 不能。
#
# 対処:
#   `prisma migrate resolve --rolled-back` で failed entry を rolled-back 扱いに変換。
#   - 初回実行 (failed entry 存在): orphan を解消 → 続く migrate deploy で新 migration 適用
#   - 2 回目以降 (既に解消済 or entry 存在しない): エラーになるが || で握りつぶす
#   この block は失敗 entry が DB から消えるまでの hotfix。production deploy 後に削除可。
echo "[netlify-build] Attempting to resolve orphan failed migration from PR #448..."
pnpm prisma migrate resolve --rolled-back "20260529_risk_issue_occurrence" 2>&1 \
  | sed 's/^/[migration-cleanup] /' \
  || echo "[migration-cleanup] No action needed (already resolved, never failed, or not present)"
echo "[netlify-build] Continuing with build:netlify..."

# 既存の build:netlify (= prisma generate + migrate deploy + next build) を実行
exec pnpm build:netlify

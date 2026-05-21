#!/usr/bin/env bash
# Netlify build wrapper: deploy context に応じて NEXTAUTH_URL を自動同期
#
# 背景:
#   Netlify は build 時に `URL` env var を自動設定する (deploy context に応じて値が変化):
#     - Production:     https://tasukiba.netlify.app
#     - Deploy Preview: https://deploy-preview-NNN--tasukiba.netlify.app
#     - Branch Deploy:  https://<branch>--tasukiba.netlify.app
#
#   一方で NEXTAUTH_URL を Netlify Dashboard で固定値 (= 本番 URL) に設定すると、
#   Deploy Preview / Branch Deploy 環境でも本番 URL を canonical として使ってしまい、
#   ステージング URL にアクセスしたユーザを本番 URL にリダイレクトする事象が発生する。
#
#   NextAuth は trustHost=true 設定でも NEXTAUTH_URL が定義されていれば優先する仕様
#   のため、env var そのものを deploy context に応じて切替える必要がある。
#
# 本スクリプトの効果:
#   - Production build:     NEXTAUTH_URL=https://tasukiba.netlify.app (= 既存挙動と同じ)
#   - Deploy Preview build: NEXTAUTH_URL=https://deploy-preview-NNN--tasukiba.netlify.app
#   - Branch Deploy build:  NEXTAUTH_URL=https://<branch>--tasukiba.netlify.app
#
# 関連: docs/operations/DEPLOYMENT.md / ADR-0016 (multi-tenant ログイン URL の context 分離)

set -euo pipefail

# Netlify 自動設定 URL を NEXTAUTH_URL に同期 (= deploy context ごとに値が変化)
# URL が未定義の場合は既存 NEXTAUTH_URL を維持 (= ローカル / Netlify 以外の環境)
export NEXTAUTH_URL="${URL:-${NEXTAUTH_URL:-https://tasukiba.netlify.app}}"
echo "[netlify-build] CONTEXT=${CONTEXT:-unknown} NEXTAUTH_URL=${NEXTAUTH_URL}"

# 既存の build:netlify (= prisma generate + migrate deploy + next build) を実行
exec pnpm build:netlify

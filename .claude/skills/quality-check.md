---
name: quality-check
description: 実装完了時に lint + test + 6 観点品質チェックを一括実行する。Stop hook の毎ターン重実行を解消するため、明示タイミングでのみ走らせる
---

# 品質チェック skill (PR 起票前 / 実装完了時)

## 背景 (なぜ skill 化したか)

旧仕様では `Stop` hook に `pnpm lint && pnpm test` (約 24 秒) と「6 観点チェック prompt」が登録されており、**Claude が応答するたび** に毎回発火していた。質問応答や調査だけのターンでも 24 秒 + 1 LLM 往復が浪費され、本来の作業速度を著しく低下させていた。

本 skill に **明示タイミング (PR 起票前 / 実装完了時)** で実行する形に分離。Stop hook には軽量な
`secret-scan` + `auto-commit` のみ残し、品質ゲートは本 skill に集約する。

## 実行タイミング

- 機能実装が完了し、コミット直前 / PR 起票直前
- 大きなリファクタリングや横展開作業の直後
- ユーザから明示的に「品質チェックお願いします」と指示されたとき

**実行不要なタイミング**:
- 質問応答 / 調査 / 設計検討のみのターン
- ドキュメントだけの軽微な修正 (この場合は `pnpm lint` のみで十分)

## 手順

### Step 1: 静的解析 + テスト

```bash
# 並列で実行 (両者独立) — 約 25 秒
pnpm lint &
LINT_PID=$!
pnpm test &
TEST_PID=$!
wait $LINT_PID && echo "[lint] OK" || echo "[lint] FAILED"
wait $TEST_PID && echo "[test] OK" || echo "[test] FAILED"
```

### Step 2: 6 観点チェック (旧 Stop hook prompt 由来)

**実装に応じて以下を確認** (該当しないものはスキップして構わない):

1. **横展開チェック**: 修正した問題と同じパターンが他ファイルに残っていないか — `Grep` で実証
2. **セキュリティチェック**: ユーザ入力のサニタイズ漏れ / 生 SQL / ハードコード機密情報がないか
3. **パフォーマンスチェック**: ループ内 DB 問い合わせ / 不要な再描画 / 不要な Provider watch がないか
4. **テスト整合性**: 変更があった場合、テストコードの旧文言が残っていないか
5. **ドキュメント更新**: 機能追加 / 仕様変更があった場合、対応ドキュメント (REQUIREMENTS / SPECIFICATION / DESIGN / OPERATION / DEVELOPER_GUIDE / E2E_COVERAGE 等) への反映が必要か
6. **ナレッジ追記 (KDD Step 4/6)**: 以下のいずれかに該当した場合、`docs/developer/DEVELOPER_GUIDE.md` または `docs/developer/E2E_LESSONS_LEARNED.md` への追記が必須:
   - (a) 罠 / 落とし穴に遭遇
   - (b) 新しい実装パターンを採用
   - (c) CI / E2E / Vercel build エラーを修正
   - (d) 横展開が必要な発見があった
   - (e) 「次回も同じ作業をしそう」と感じた手順がある

   **commit message に書いただけでは不十分** — 常設ナレッジに新セクションを追記する。

### Step 3: 報告

問題なければ「品質チェック完了: 問題なし」と報告。問題があれば修正箇所と修正方針を提示し、修正後に再度 Step 1〜2 を回す。

## 関連

- `.claude/settings.json` の Stop hook (旧仕様の lint/test/prompt 重実行を本 skill に分離)
- `.claude/skills/threat-model.md` Mode B-1 (PR 起票時のセキュリティスコア確認 — 本 skill と併用)
- DEVELOPER_GUIDE §5.50 (本 skill 化の経緯と Stop hook 改修)

#!/usr/bin/env bash
# PreToolUse hook: git commit / git push / gh pr create を既定でブロックする。
# 終了コード 2 + stderr でツール実行を中止させる。
#
# 方針 (CLAUDE.md / project_dev_workflow_enforcement_plan と整合):
#   - コミット/プッシュ/PR 作成は「ユーザの明示指示があったときのみ」。
#   - Claude が勝手に commit/push/PR しない安全装置 (緊急時運用は安全最優先)。
#
# 解除方法 (合言葉):
#   環境変数 ALLOW_GIT_PUBLISH=1 がセットされている場合のみ通す。
#   ユーザが「コミットして」と明示したターンで、Claude が
#   `ALLOW_GIT_PUBLISH=1 git commit ...` の形で実行する運用。
#   (PowerShell の場合は $env:ALLOW_GIT_PUBLISH='1'; git commit ...)

set -u

# 合言葉が立っていれば即許可 (環境変数 or コマンド先頭プレフィックス)
if [ "${ALLOW_GIT_PUBLISH:-}" = "1" ]; then
  exit 0
fi

# コマンド文字列先頭に ALLOW_GIT_PUBLISH=1 が付いている場合も許可
# (PreToolUse hook 実行時点では env var はまだ展開されていないため、
#  コマンド文字列から直接検出する必要がある)
_CMD_EARLY="${CLAUDE_TOOL_INPUT:-}"
if [ -z "$_CMD_EARLY" ]; then
  _CMD_EARLY="$(cat || true)"
fi
_CMD_EARLY="$(echo "$_CMD_EARLY" | grep -oE '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/^"command"[[:space:]]*:[[:space:]]*"//; s/"$//')"
if echo "$_CMD_EARLY" | grep -qE '^[[:space:]]*ALLOW_GIT_PUBLISH=1[[:space:]]'; then
  exit 0
fi

INPUT="${CLAUDE_TOOL_INPUT:-}"
if [ -z "$INPUT" ]; then
  INPUT="$(cat || true)"
fi

# command フィールドの値だけを取り出す (JSON の "command":"..." を抽出)。
# 取れない場合は入力全体を対象にフォールバック。
CMD="$(echo "$INPUT" | grep -oE '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/^"command"[[:space:]]*:[[:space:]]*"//; s/"$//')"
[ -z "$CMD" ] && CMD="$INPUT"

# 実際のコマンド起動位置 (行頭 / ; / && / || / | / ( の直後) の git・gh のみを検出する。
# これにより `grep "git push"` や `echo git commit` のように文字列として
# 言及しただけのケースを誤ブロックしない。
# 先頭の環境変数代入 (FOO=bar git ...) も許容するため [A-Za-z0-9_]*=... を読み飛ばす。
LEAD='(^|[;&|(]|&&|\|\|)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*'
detect() {
  if echo "$CMD" | grep -qE "${LEAD}git[[:space:]]+([^;&|]*[[:space:]])?commit\b"; then
    echo "commit"; return 0
  fi
  if echo "$CMD" | grep -qE "${LEAD}git[[:space:]]+([^;&|]*[[:space:]])?push\b"; then
    echo "push"; return 0
  fi
  if echo "$CMD" | grep -qE "${LEAD}gh[[:space:]]+pr[[:space:]]+create\b"; then
    echo "pr-create"; return 0
  fi
  return 1
}

if action="$(detect)"; then
  echo "BLOCKED: git $action は既定で禁止されています (コミット/プッシュ/PR 作成はユーザの明示指示があるときのみ)。" >&2
  echo "  - ユーザが明示的に依頼した場合のみ、合言葉つきで実行してください:" >&2
  echo "      bash:       ALLOW_GIT_PUBLISH=1 <そのコマンド>" >&2
  echo "      PowerShell: \$env:ALLOW_GIT_PUBLISH='1'; <そのコマンド>" >&2
  echo "  - 月次ブランチ month/YYYY-MM への直接コミット運用と整合させること。" >&2
  echo "  - main / develop / release/* / hotfix/* への直接 push は別途禁止。" >&2
  exit 2
fi

exit 0

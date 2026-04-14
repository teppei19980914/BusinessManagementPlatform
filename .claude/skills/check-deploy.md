---
name: check-deploy
description: CI/CDのデプロイ結果を確認し、失敗時は原因を調査・修正する
---

# デプロイ確認スキル

## 手順

1. 最新のデプロイ状態を確認する

```bash
gh run list --limit 3
```

2. 失敗時はログを取得する

```bash
gh run view <RUN_ID> --log-failed
```

3. 原因を特定する
   - 静的解析エラー → ソースコード修正
   - テスト失敗 → テストコードまたはソースコード修正
   - ビルドエラー → 依存関係やアセットの問題

4. 修正後にローカルで検証する

```bash
{{ANALYZE_COMMAND}}
{{TEST_COMMAND}}
```

5. ユーザーにコミット & プッシュを案内する

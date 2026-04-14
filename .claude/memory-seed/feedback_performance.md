---
name: feedback_performance
description: パフォーマンス閾値は全操作1秒以内。環境差を考慮した閾値設定ルール
type: feedback
originSessionId: 2256dc31-9f5d-432f-9efc-bc90c56fcf76
---
本ユーザーのアプリのパフォーマンス閾値は **全操作1秒以内** とする。

**Why:** ユーザー体験を損なわないための基準。GrowthEngine で採用した原則。

**How to apply:**
- テスト環境と本番環境の速度差を考慮し、テスト閾値は本番の2倍程度に設定
- ストレステストを定期的に実行し、閾値超過をCI等で検知
- 閾値超過が検出された場合、ボトルネック特定→改善を優先タスクとする

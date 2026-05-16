# docs/archive/ — アーカイブ

本ディレクトリは、**完了済イベントの記録 / 履歴的価値はあるが現役運用では参照しないドキュメント** を保全します。

> **2026-05-17 再新設**: 過去の docs/archive/ (役割別構造への移行で発生した旧版) は 2026-05-14 に PR #369 で削除済。
> 本 archive は **「完了済プロジェクト / 終了したイベントの記録」を残す** という新しい用途で再運用します。

---

## 何を archive するか

### archive する基準

以下のいずれかに該当するドキュメントを archive 対象とする:

- **完了済イベントの記録**: 特定 PR / 特定リリース / 特定改修プロジェクトの記録で、もう発生しないもの
- **完了済 plan / TODO**: 実行が終わり、参照されなくなったロードマップや TODO リスト
- **過去の監査・検証レポート**: 特定時点のスナップショット (パフォーマンス監査、レスポンシブ監査等)

### archive しない基準

以下は archive 対象外 (active のまま継続):

- **active な機能の脅威モデル**: 該当機能が production にある間は将来の修正時に参照する
- **設計判断 (ADR)**: 後戻りコストが高い判断は永続的に有効
- **業務ルール / 仕様**: 顧客に提供している機能の仕様は active
- **運用手順 (SOP)**: 定期的に実行される手順
- **教訓 / KDD ナレッジ**: 同種の問題が再発しうるため永続的に有効

---

## ディレクトリ構造

| サブディレクトリ | 用途 |
|---|---|
| [performance/](./performance/) | 過去のパフォーマンス改修プロジェクトの記録 (日付フォルダで管理) |
| [roadmap/](./roadmap/) | 完了済のロードマップ / 計画書 / TODO リスト |
| [audits/](./audits/) | 特定時点の監査・検証レポート (レスポンシブ / アクセシビリティ等) |
| [release-notes/](./release-notes/) (Phase 2 以降) | 特定機能の個別リリースノート |
| [verifications/](./verifications/) (Phase 2 以降) | 特定改修の検証記録 |
| [future-plans/](./future-plans/) (将来必要時) | 撤退・優先度低下した将来構想 |

---

## 新規 archive 追加のルール

1. **対象を特定**: 上記「archive する基準」に該当するか確認
2. **適切なサブディレクトリ**: 既存があればそこへ、なければ新設
3. **`git mv`** でファイルを移動 (履歴を保つ)
4. **本 README の索引** に 1 行追加
5. **元の場所からの参照リンク** を確認し、必要に応じて archive 内へ更新 (壊れた参照を残さない)
6. PR を起票してマージ

---

## 索引 (現在の archive 内容)

### performance/

| 移動日 | 元の場所 | 移動先 | 経緯 |
|---|---|---|---|
| 2026-05-17 | docs/design/performance/20260417/ | [performance/20260417/](./performance/20260417/) | 2026-04 パフォーマンス改修プロジェクトの記録。完了済 |

### roadmap/

| 移動日 | 元の場所 | 移動先 | 経緯 |
|---|---|---|---|
| 2026-05-17 | docs/roadmap/MVP_HISTORICAL.md | [roadmap/MVP_HISTORICAL.md](./roadmap/MVP_HISTORICAL.md) | MVP 構築計画 (2026-04 完了)、既に履歴ラベル付きだったため archive 化 |

### audits/

| 移動日 | 元の場所 | 移動先 | 経緯 |
|---|---|---|---|
| 2026-05-17 | docs/design/RESPONSIVE_AUDIT.md | [audits/RESPONSIVE_AUDIT.md](./audits/RESPONSIVE_AUDIT.md) | PR #128 レスポンシブ監査レポート、完了済 |

---

## Future archive plan — トリガ条件付き予定リスト

以下のドキュメントは、現時点では active だが **特定イベント完了後に archive 化する** ことが計画済。

### Phase 2: 6/1 リリース完了後

リリースが正常完了したら、関連する完了済 plan を archive へ移動:

| 対象 | 移動先 | トリガ条件 |
|---|---|---|
| `docs/roadmap/V1_FINAL_TASKS.md` | `docs/archive/roadmap/V1_FINAL_TASKS.md` | 6/1 リリース完了、全 V1 タスク完了確認後 |
| `docs/roadmap/ROLE_REFACTORING_PLAN.md` | `docs/archive/roadmap/ROLE_REFACTORING_PLAN.md` | ロール再構築リリース完了確認後 |
| `docs/roadmap/SUGGESTION_ENGINE_PLAN.md` | `docs/archive/roadmap/SUGGESTION_ENGINE_PLAN.md` | T-03 リリース完了確認後 |
| `docs/operations/SUGGESTION_ENGINE_VERIFICATION.md` | `docs/archive/verifications/SUGGESTION_ENGINE.md` | T-03 リリース後 1 ヶ月 (運用上問題なし確認) |
| `docs/operations/T-03_RELEASE_NOTES.md` | `docs/archive/release-notes/T-03.md` | T-03 リリース後 1 ヶ月 |

### Phase 3: Stripe v1.x リリース完了後

| 対象 | 移動先 | トリガ条件 |
|---|---|---|
| `docs/roadmap/STRIPE_INTEGRATION_PLAN.md` | `docs/archive/roadmap/STRIPE_INTEGRATION_PLAN.md` | Stripe Metered Billing 連携リリース完了 |

### Phase 4 (active 維持の判断、参考)

以下は archive 候補だったが、**active 維持** と決定:

| 対象 | 判断理由 |
|---|---|
| `docs/security/PHASE2_THREAT_MODEL.md` | 該当機能が production active のため、将来修正時の参照として残す |
| `docs/security/SUGGESTION_ENGINE_THREAT_MODEL.md` | 提案エンジンが active 機能のため残す |
| `docs/security/TENANT_ISOLATION_PHASE2_TODO.md` | 完了状況未確定のため active 維持 (完了したら archive 化を再検討) |
| `docs/developer-guide/TODO_LIST.md` | 完了済項目を履歴として保全する運用ルールのため active 維持 |

### 実行方法

Phase 2-3 トリガ発火時の作業:

1. 該当ファイルを archive へ `git mv`
2. 元の場所の README 索引から削除
3. 本 README の「索引」セクションに移動記録を追加
4. 旧 docs/ 内で当該ファイルを参照しているリンクを修正 (lychee CI で自動検出)
5. PR で説明と共に提示

---

## archive からの復活 (un-archive)

ドキュメントが再び active な参照対象になった場合は、逆操作で復活させる:

1. `git mv docs/archive/<path> docs/<original-path>` で元の場所に戻す
2. 本 README の索引から該当エントリを削除
3. 元の場所の README 索引にエントリを復活させる
4. 復活理由を PR 説明に記載

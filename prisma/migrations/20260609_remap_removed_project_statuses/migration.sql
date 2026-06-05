-- 2026-06-03: プロジェクトステータス「完了 (completed)」「振り返り完了 (retrospected)」を廃止。
--   実行中のプロジェクトを終える際は「クローズ (closed)」へ遷移する 5 ステータス構成に簡素化した
--   (PROJECT_STATUSES / state-machine / STATE_RESTRICTIONS を更新)。
--
--   status 列は VARCHAR(20) で DB 制約は無いため、既存データに 'completed' / 'retrospected' が
--   残っていると UI でラベル解決できず raw 値が表示される。両ステータスは「作業後の段階」を表して
--   いたため、新モデルの終端である 'closed' に読み替える (= 読み取り専用のアーカイブ扱い)。
--
--   冪等: 対象が無ければ 0 行更新で安全。論理削除済 (deletedAt) も含めて整合させる。

UPDATE "projects"
SET "status" = 'closed'
WHERE "status" IN ('completed', 'retrospected');

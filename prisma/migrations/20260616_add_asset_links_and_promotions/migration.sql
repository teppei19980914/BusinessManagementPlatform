-- v1.3.0: 資産導線機能 — 昇華リンク 2 本 + 汎用手動リンク 1 本を追加。
-- 非破壊 (新規テーブル追加のみ。既存テーブル・行への変更なし)。

-- リスク → 課題 の昇華リンク (M:N)。
-- risk/issue 両方が ON DELETE CASCADE: どちらかが削除されると昇華レコードも連動削除される。
CREATE TABLE "risk_issue_promotions" (
  "risk_id"    UUID        NOT NULL,
  "issue_id"   UUID        NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "created_by" UUID        NOT NULL,
  CONSTRAINT "risk_issue_promotions_pkey" PRIMARY KEY ("risk_id", "issue_id"),
  CONSTRAINT "risk_issue_promotions_risk_id_fkey"
    FOREIGN KEY ("risk_id") REFERENCES "risks_issues"("id") ON DELETE CASCADE,
  CONSTRAINT "risk_issue_promotions_issue_id_fkey"
    FOREIGN KEY ("issue_id") REFERENCES "risks_issues"("id") ON DELETE CASCADE,
  CONSTRAINT "risk_issue_promotions_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id")
);

CREATE INDEX "idx_risk_issue_promotions_risk"  ON "risk_issue_promotions"("risk_id");
CREATE INDEX "idx_risk_issue_promotions_issue" ON "risk_issue_promotions"("issue_id");

-- 課題 → ナレッジ の昇華リンク (M:N)。
-- issue/knowledge 両方が ON DELETE CASCADE。
CREATE TABLE "issue_knowledge_promotions" (
  "issue_id"     UUID        NOT NULL,
  "knowledge_id" UUID        NOT NULL,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "created_by"   UUID        NOT NULL,
  CONSTRAINT "issue_knowledge_promotions_pkey" PRIMARY KEY ("issue_id", "knowledge_id"),
  CONSTRAINT "issue_knowledge_promotions_issue_id_fkey"
    FOREIGN KEY ("issue_id") REFERENCES "risks_issues"("id") ON DELETE CASCADE,
  CONSTRAINT "issue_knowledge_promotions_knowledge_id_fkey"
    FOREIGN KEY ("knowledge_id") REFERENCES "knowledges"("id") ON DELETE CASCADE,
  CONSTRAINT "issue_knowledge_promotions_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id")
);

CREATE INDEX "idx_issue_knowledge_promotions_issue"     ON "issue_knowledge_promotions"("issue_id");
CREATE INDEX "idx_issue_knowledge_promotions_knowledge" ON "issue_knowledge_promotions"("knowledge_id");

-- 汎用手動リンク (ポリモーフィック)。
-- from_entity_type / to_entity_type の値: 'risk' | 'issue' | 'knowledge' | 'retrospective' | 'memo'
-- entity ID 列に FK を付けない (ポリモーフィック設計)。
-- entity 削除時の孤立リンクはアプリケーション層でクリーンアップする。
-- tenant_id は ADR-0015 / DATA_MODEL.md §6 の方針通り NO ACTION (他テーブルと統一、
-- テナント削除はアプリ層の明示的 cascade に委ねる。DB 自動 cascade は使わない)。
CREATE TABLE "asset_links" (
  "id"               UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"        UUID        NOT NULL,
  "from_entity_type" VARCHAR(20) NOT NULL,
  "from_entity_id"   UUID        NOT NULL,
  "to_entity_type"   VARCHAR(20) NOT NULL,
  "to_entity_id"     UUID        NOT NULL,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "created_by"       UUID        NOT NULL,
  CONSTRAINT "asset_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_links_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
  CONSTRAINT "asset_links_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id")
);

CREATE INDEX "idx_asset_links_from" ON "asset_links"("tenant_id", "from_entity_type", "from_entity_id");
CREATE INDEX "idx_asset_links_to"   ON "asset_links"("tenant_id", "to_entity_type",   "to_entity_id");

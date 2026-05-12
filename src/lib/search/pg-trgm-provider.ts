/**
 * pg_trgm 検索プロバイダ（設計書: DESIGN.md セクション 16）
 * PostgreSQL 標準の pg_trgm 拡張を使用した全文検索。
 *
 * 2026-05-12 severity-1 防御: tenantId フィルタを必須化 + visibility 認可ガード追加。
 *   旧仕様は where に tenantId / visibility いずれも含まず、有効化された場合に即座に
 *   クロステナント情報漏洩 + draft 漏洩を引き起こす脆弱な実装だった。
 *   呼出側 (SearchParams) で必ず tenantId を渡す契約に変更し、本実装はそれを where に転写。
 */

import { prisma } from '@/lib/db';
import type { SearchProvider, SearchParams, SearchResult } from './search-provider';

export class PgTrgmSearchProvider implements SearchProvider {
  async search(params: SearchParams): Promise<SearchResult[]> {
    const query = params.query.slice(0, 200); // クエリ最大200文字
    if (query.length < 2) return []; // 最小2文字

    const results: SearchResult[] = [];

    if (params.entityTypes.includes('knowledge')) {
      // 2026-05-12 severity-1 防御:
      //   1. tenantId フィルタ必須 (越境遮断)
      //   2. visibility='public' をデフォルト、viewerUserId 指定時は自分の draft も許容
      //   3. viewerIsAdmin=true なら自テナント内の draft も全件許容
      //   visibilityWhere と textSearch を **AND** で結合 (両 OR の衝突を回避)
      const visibilityCondition = params.viewerIsAdmin
        ? {}
        : params.viewerUserId
          ? {
              OR: [
                { visibility: 'public' },
                { visibility: 'draft', createdBy: params.viewerUserId },
              ],
            }
          : { visibility: 'public' };

      const textSearchCondition = {
        OR: [
          { title: { contains: query, mode: 'insensitive' as const } },
          { content: { contains: query, mode: 'insensitive' as const } },
          { conclusion: { contains: query, mode: 'insensitive' as const } },
        ],
      };

      const knowledges = await prisma.knowledge.findMany({
        where: {
          tenantId: params.tenantId,
          deletedAt: null,
          AND: [visibilityCondition, textSearchCondition],
        },
        select: { id: true, title: true, content: true },
        take: params.limit,
        skip: params.offset,
      });

      for (const k of knowledges) {
        const contentSnippet = k.content.length > 100
          ? k.content.slice(0, 100) + '...'
          : k.content;
        results.push({
          entityType: 'knowledge',
          entityId: k.id,
          title: k.title,
          snippet: contentSnippet,
          score: 1,
        });
      }
    }

    return results;
  }
}

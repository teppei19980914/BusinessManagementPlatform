/**
 * pg_trgm 検索プロバイダ（設計書: DESIGN.md セクション 16）
 * PostgreSQL 標準の pg_trgm 拡張を使用した全文検索。
 */

import { prisma } from '@/lib/db';
import type { SearchProvider, SearchParams, SearchResult } from './search-provider';

export class PgTrgmSearchProvider implements SearchProvider {
  async search(params: SearchParams): Promise<SearchResult[]> {
    const query = params.query.slice(0, 200); // クエリ最大200文字
    if (query.length < 2) return []; // 最小2文字

    const results: SearchResult[] = [];

    if (params.entityTypes.includes('knowledge')) {
      const knowledges = await prisma.knowledge.findMany({
        where: {
          deletedAt: null,
          OR: [
            { title: { contains: query, mode: 'insensitive' } },
            { content: { contains: query, mode: 'insensitive' } },
            { conclusion: { contains: query, mode: 'insensitive' } },
          ],
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

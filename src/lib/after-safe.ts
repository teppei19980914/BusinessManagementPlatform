/**
 * PR-9 perf (2026-05-29 / ADR-0026): `next/server` の `after()` をテスト環境でも安全に呼べる薄いラッパ。
 *
 * 背景:
 *   Next.js 16 の `after()` は「request scope」内 (= route handler / server action / server component
 *   render 中) でのみ呼び出せる仕様で、それ以外 (vitest 単体テスト等) で呼ぶと例外を throw する。
 *   このため、service 関数を直接ユニットテストする経路で `after()` を含むと全テストが壊れる。
 *
 * 設計:
 *   - 本番 (request scope 内): 引数の promise を `after()` に渡す → response 完了後にバックグラウンド実行
 *   - 単体テスト (request scope 外): `after()` が throw する例外を catch し、promise を `.catch(noop)`
 *     で consume する。fire-and-forget と同等の挙動になるが、テスト環境では実際には awaiter
 *     チェーンに乗らないため、テスト終了時に Voyage 等の外部呼出が走らないようにすること。
 *
 * 使い方:
 *   旧: `await generateAndPersistEntityEmbedding({...})`
 *   新: `afterSafe(generateAndPersistEntityEmbedding({...}).catch((e) => console.error(e)))`
 */

import { after } from 'next/server';

/**
 * `after()` の薄いラッパ。テスト環境 (request scope 外) では throw せず promise を consume する。
 */
export function afterSafe(promise: Promise<unknown>): void {
  try {
    after(promise);
  } catch {
    // request scope 外 (= 単体テスト等)。Promise を catch で consume してアンハンドル拒否を防ぐ。
    void promise.catch(() => {
      /* swallow — テスト環境での silent failure */
    });
  }
}

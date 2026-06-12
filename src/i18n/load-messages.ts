/**
 * メッセージカタログ読込 + 分割ファイル shallow merge + namespace 衝突検出。
 *
 * 関連:
 *   - docs/i18n/CONVENTIONS.md §2 (messages/ ディレクトリ構造)
 *   - PR (i18n zero-hardcode): 主 ja.json 1 ファイルが 5000+ key になることを避け、
 *     大物 (email/help/guide/faq) を namespace 別 sub-file に分割する設計。
 *
 * 設計:
 *   - 主カタログ: messages/<locale>.json
 *   - 分割サブカタログ: messages/<locale>/<name>.json
 *     - 各サブカタログは **単一の top-level namespace** を持つ ({ "email": { ... } })
 *     - 衝突検出: サブカタログの top-level key が主 or 他サブと重複したら build/runtime で throw
 *   - 結合: shallow merge (top-level namespace 単位)
 *
 * 制限事項:
 *   - 深い階層の merge はしない (混乱の元)
 *   - 同名サブカタログを複数 locale で持つ義務はないが、本実装では片方欠落は許容しない
 *     (messages.test.ts の parity 検証で検出)
 */

import type { AbstractIntlMessages } from 'next-intl';
import type { Locale } from './request';

/**
 * 分割サブカタログ名一覧。
 * 追加するときは:
 *   1. messages/<locale>/<name>.json をすべての対象 locale で新規作成
 *   2. 本配列に名前を追加
 *   3. docs/i18n/CONVENTIONS.md §2 にも記載
 */
export const MESSAGE_SUBFILES = ['email', 'help', 'guide', 'faq'] as const;
export type MessageSubfile = (typeof MESSAGE_SUBFILES)[number];

interface NamespaceObject {
  [namespace: string]: unknown;
}

/**
 * 与えられたオブジェクト群を shallow merge し、top-level namespace 衝突を検出する。
 * 衝突があれば Error を投げる (build/runtime 早期 fail)。
 */
export function mergeMessagesStrict(
  parts: Array<{ source: string; messages: NamespaceObject }>,
): NamespaceObject {
  const result: NamespaceObject = {};
  const owners = new Map<string, string>(); // namespace -> source

  for (const { source, messages } of parts) {
    for (const [namespace, value] of Object.entries(messages)) {
      const owner = owners.get(namespace);
      if (owner) {
        throw new Error(
          `[i18n] namespace "${namespace}" is defined in both "${owner}" and "${source}". ` +
            `Each top-level namespace must live in exactly one file. ` +
            `See docs/i18n/CONVENTIONS.md §2.`,
        );
      }
      owners.set(namespace, source);
      result[namespace] = value;
    }
  }

  return result;
}

/**
 * 指定 locale のカタログを (主 + 全サブファイル) ロードして結合する。
 * 各サブファイルが空 ({}) でも結合は成功 (parity test 用にファイル存在のみ要求)。
 */
export async function loadMessagesForLocale(locale: Locale): Promise<AbstractIntlMessages> {
  const main = (await import(`./messages/${locale}.json`)).default as NamespaceObject;

  const parts: Array<{ source: string; messages: NamespaceObject }> = [
    { source: `messages/${locale}.json`, messages: main },
  ];

  for (const name of MESSAGE_SUBFILES) {
    const sub = (await import(`./messages/${locale}/${name}.json`)).default as NamespaceObject;
    parts.push({ source: `messages/${locale}/${name}.json`, messages: sub });
  }

  return mergeMessagesStrict(parts) as AbstractIntlMessages;
}

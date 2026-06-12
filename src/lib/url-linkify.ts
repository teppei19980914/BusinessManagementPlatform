/**
 * テキスト中の http / https URL を検出し、「URL 部分」と「それ以外のテキスト」に
 * 分割する純粋ユーティリティ (feat/url-autolink)。
 *
 * 役割:
 *   各資産のテキストフィールド (内容・対策・良かった点・説明・備考・コメント等) で、
 *   入力された URL を表示時にハイパーリンク化するための土台。React にも remark/mdast
 *   にも依存しない純粋関数として切り出し、テスト容易性と再利用性を担保する。
 *
 * 設計上の肝 — 日本語 (CJK) 直後の URL 境界:
 *   「https://tasukiba.com/login にアクセスしてください。」のように URL の直後へ
 *   空白なしで日本語が続くケースで、URL 部分 (`https://tasukiba.com/login`) だけを
 *   リンク化する必要がある。標準的な GFM の autolink は「空白か `<` までを URL とみなす」
 *   ため、空白で区切られない日本語や全角句点 (。) を URL に巻き込んでしまう。
 *   そこで本実装では URL を構成しうる文字を **RFC 3986 の ASCII 文字集合に限定** し、
 *   非 ASCII (日本語・全角記号) が現れた時点で URL を打ち切る。これにより
 *   「`https://tasukiba.com/login` + `にアクセス…`」へ正しく分割できる。
 *
 * 参照: RFC 3986 (https://www.rfc-editor.org/rfc/rfc3986) — URI に使用可能な文字。
 *   unreserved = A-Z a-z 0-9 - . _ ~ / gen-delims・sub-delims = : / ? # [ ] @ ! $ & ' ( ) * + , ; =
 *   / percent-encoding の %。非 ASCII は本来パーセントエンコードが必要 (= 生の日本語は URL 外)。
 */

/** 分割後の 1 セグメント。type='url' はリンク化対象、type='text' はそのまま表示。 */
export interface LinkifySegment {
  type: 'text' | 'url';
  value: string;
}

/**
 * http(s) URL の本体マッチ。スキーム + RFC 3986 で URI に使える ASCII 文字の連続。
 * 非 ASCII (日本語等) はこのクラスに含まれないため、そこで自動的に打ち切られる。
 * 末尾の文末句読点・対応の取れない閉じ括弧は trimUrlTrailing() で後段除去する。
 */
const URL_BODY = "[A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%]";
const URL_REGEX_SOURCE = `https?://${URL_BODY}+`;

/** 末尾から除去しうる「文末に付きがちで URL 末尾になり得ない」ASCII 文字。 */
const TRAILING_PUNCTUATION = new Set([
  '.', ',', ';', ':', '!', '?', "'", '"', '<', '>', '*', '_', '~',
]);

/**
 * マッチした URL 末尾の文末記号を除去する。
 *   - 文末句読点 (. , ; : ! ? 等) は末尾から剥がす
 *   - 閉じ括弧 ) ] } は、URL 内で開き括弧と対応していない (= 文章側の括弧) ときのみ剥がす
 *     例: "(詳細は https://example.com/page)" → 末尾 ) は URL 外
 *         "https://ja.wikipedia.org/wiki/Foo_(bar)" → 対応が取れているので保持
 */
function trimUrlTrailing(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (TRAILING_PUNCTUATION.has(ch)) {
      end -= 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const open = ch === ')' ? '(' : ch === ']' ? '[' : '{';
      const sub = url.slice(0, end);
      const opens = countChar(sub, open);
      const closes = countChar(sub, ch);
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === ch) n += 1;
  }
  return n;
}

/**
 * テキストを URL セグメントと通常テキストセグメントに分割する。
 * URL を 1 つも含まない場合は `[{ type: 'text', value: text }]` (空文字なら空配列)。
 *
 * @example
 *   splitByUrl('https://tasukiba.com/login にアクセス')
 *   // → [{url:'https://tasukiba.com/login'}, {text:' にアクセス'}]
 *   splitByUrl('https://tasukiba.com/loginにアクセスしてください。')
 *   // → [{url:'https://tasukiba.com/login'}, {text:'にアクセスしてください。'}]
 */
export function splitByUrl(text: string): LinkifySegment[] {
  if (!text) return [];
  const segments: LinkifySegment[] = [];
  const re = new RegExp(URL_REGEX_SOURCE, 'g');
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const rawUrl = match[0];
    const start = match.index;
    const url = trimUrlTrailing(rawUrl);

    // スキーム直後に実体が無い等で空になった場合はテキスト扱い (異常系の保険)
    if (url.length <= 'https://'.length) {
      // 巻き戻して 1 文字進め、無限ループを避ける
      re.lastIndex = start + 1;
      continue;
    }

    if (start > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, start) });
    }
    segments.push({ type: 'url', value: url });

    // trim で削った末尾文字はテキスト側に戻すため、URL 実長で lastIndex を進める
    lastIndex = start + url.length;
    re.lastIndex = lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return segments;
}

/** テキストが少なくとも 1 つの http(s) URL を含むか。 */
export function containsUrl(text: string): boolean {
  if (!text) return false;
  return new RegExp(URL_REGEX_SOURCE).test(text);
}

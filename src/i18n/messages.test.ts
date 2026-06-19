/**
 * Message catalog integrity tests.
 *
 * Coverage:
 *   1. Phase A/B/C required keys (legacy, kept for back-compat regression)
 *   2. ja ↔ en-US key parity (flatten then compare sets) — covers main catalog
 *      AND every sub-file (email/help/guide/faq).
 *   3. ICU placeholder consistency: for each key, the set of `{var}` names is identical
 *      across locales (catches `Hello {name}` vs `Hello {n}` drift).
 *   4. Sub-file namespace rule: each split file has exactly one top-level namespace
 *      and that namespace matches the file basename.
 *   5. Loader (load-messages.ts) merges without collision and throws on simulated
 *      collision.
 *
 * Related:
 *   - docs/i18n/CONVENTIONS.md §2 §3 §4
 *   - src/i18n/load-messages.ts
 *
 * Out of scope (intentionally not enforced yet):
 *   - Unused key detection (would require AST grep across full src/; tracked separately
 *     via `pnpm check:no-hardcoded-jp:report`)
 */

import { describe, it, expect } from 'vitest';
import jaMessages from './messages/ja.json';
import jaEmail from './messages/ja/email.json';
import jaHelp from './messages/ja/help.json';
import jaGuide from './messages/ja/guide.json';
import jaFaq from './messages/ja/faq.json';
import jaSuperAdmin from './messages/ja/superAdmin.json';
import enMessages from './messages/en-US.json';
import enEmail from './messages/en-US/email.json';
import enHelp from './messages/en-US/help.json';
import enGuide from './messages/en-US/guide.json';
import enFaq from './messages/en-US/faq.json';
import enSuperAdmin from './messages/en-US/superAdmin.json';
import { mergeMessagesStrict, MESSAGE_SUBFILES } from './load-messages';

type AnyObject = { [k: string]: unknown };

const REQUIRED_ACTION_KEYS = [
  'save',
  'cancel',
  'delete',
  'edit',
  'create',
  'back',
  'close',
  'today',
  'clear',
  'add',
] as const;

const REQUIRED_FIELD_KEYS = [
  'title',
  'content',
  'body',
  'name',
  'displayName',
  'purpose',
  'background',
  'result',
  'assignee',
  'deadline',
  'visibility',
  'kind',
  'impact',
  'likelihood',
  'riskNature',
  'conductedDate',
  'plannedEndDate',
  'currentPassword',
  'newPassword',
  'newPasswordConfirm',
] as const;

const REQUIRED_MESSAGE_KEYS = [
  'saveSuccess',
  'saveFailed',
  'createFailed',
  'updateFailed',
  'deleteSuccess',
  'deleteFailed',
  'deleteConfirm',
  'fetchFailed',
  'validationError',
  'passwordChangeFailed',
  'passwordChanged',
  'noData',
  'loading',
] as const;

/** Flatten nested catalog object to dotted key map (only leaf strings retained). */
function flatten(obj: AnyObject, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v as AnyObject, key));
    } else if (typeof v === 'string') {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Extract ICU placeholder argument names from a value.
 * Captures `{name}` / `{name, plural, ...}` / `{name, date, medium}` etc.
 * Does NOT recurse into plural sub-arms (those use `#` not `{name}`); a wrong
 * name inside an arm would surface as a separate placeholder anyway.
 */
function extractPlaceholders(value: string): Set<string> {
  const names = new Set<string>();
  // Match `{name` or `{name,` or `{name }` at the start of an ICU expression.
  const re = /\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*[,}]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    names.add(m[1]);
  }
  return names;
}

describe('messages catalog — legacy required keys (ja)', () => {
  it('action 配下に Phase A 必須キーがすべて存在する', () => {
    const action = (jaMessages as { action?: Record<string, string> }).action ?? {};
    for (const key of REQUIRED_ACTION_KEYS) {
      expect(action[key], `action.${key} must be defined`).toBeTruthy();
      expect(typeof action[key]).toBe('string');
    }
  });

  it('action 配下に余計なキーが混入していない (既知集合との一致)', () => {
    const action = (jaMessages as { action?: Record<string, string> }).action ?? {};
    const actualKeys = Object.keys(action).sort();
    const expectedKeys = [...REQUIRED_ACTION_KEYS].sort();
    expect(actualKeys).toEqual(expectedKeys);
  });

  it('action 配下のすべての値が空文字でない', () => {
    const action = (jaMessages as { action?: Record<string, string> }).action ?? {};
    for (const [key, value] of Object.entries(action)) {
      expect(value.length, `action.${key} must not be empty`).toBeGreaterThan(0);
    }
  });

  it('field 配下に Phase B 必須キーがすべて存在する (PR #81)', () => {
    const field = (jaMessages as { field?: Record<string, string> }).field ?? {};
    for (const key of REQUIRED_FIELD_KEYS) {
      expect(field[key], `field.${key} must be defined`).toBeTruthy();
      expect(typeof field[key]).toBe('string');
    }
  });

  it('message 配下に Phase C 必須キーがすべて存在する (PR #81)', () => {
    const message = (jaMessages as { message?: Record<string, string> }).message ?? {};
    for (const key of REQUIRED_MESSAGE_KEYS) {
      expect(message[key], `message.${key} must be defined`).toBeTruthy();
      expect(typeof message[key]).toBe('string');
    }
  });
});

describe('messages catalog — sub-file namespace rule', () => {
  // Each sub-file must contain exactly one top-level namespace, and that namespace
  // must match the file basename. This prevents accidental collisions with the main
  // catalog and keeps `mergeMessagesStrict` deterministic.
  const cases: Array<{ name: string; ja: AnyObject; en: AnyObject }> = [
    { name: 'email', ja: jaEmail as AnyObject, en: enEmail as AnyObject },
    { name: 'help', ja: jaHelp as AnyObject, en: enHelp as AnyObject },
    { name: 'guide', ja: jaGuide as AnyObject, en: enGuide as AnyObject },
    { name: 'faq', ja: jaFaq as AnyObject, en: enFaq as AnyObject },
    { name: 'superAdmin', ja: jaSuperAdmin as AnyObject, en: enSuperAdmin as AnyObject },
  ];

  it.each(cases)('sub-file "$name" has exactly one top-level namespace = $name', ({ name, ja, en }) => {
    expect(Object.keys(ja)).toEqual([name]);
    expect(Object.keys(en)).toEqual([name]);
  });

  it('MESSAGE_SUBFILES is exhaustive vs the test cases above', () => {
    expect([...MESSAGE_SUBFILES].sort()).toEqual(cases.map((c) => c.name).sort());
  });
});

describe('messages catalog — ja/en-US parity', () => {
  // Build complete (main + sub) catalog for each locale and assert structural equality.
  const jaFull = mergeMessagesStrict([
    { source: 'ja.json', messages: jaMessages as AnyObject },
    { source: 'ja/email.json', messages: jaEmail as AnyObject },
    { source: 'ja/help.json', messages: jaHelp as AnyObject },
    { source: 'ja/guide.json', messages: jaGuide as AnyObject },
    { source: 'ja/faq.json', messages: jaFaq as AnyObject },
    { source: 'ja/superAdmin.json', messages: jaSuperAdmin as AnyObject },
  ]);
  const enFull = mergeMessagesStrict([
    { source: 'en-US.json', messages: enMessages as AnyObject },
    { source: 'en-US/email.json', messages: enEmail as AnyObject },
    { source: 'en-US/help.json', messages: enHelp as AnyObject },
    { source: 'en-US/guide.json', messages: enGuide as AnyObject },
    { source: 'en-US/faq.json', messages: enFaq as AnyObject },
    { source: 'en-US/superAdmin.json', messages: enSuperAdmin as AnyObject },
  ]);

  const jaFlat = flatten(jaFull as AnyObject);
  const enFlat = flatten(enFull as AnyObject);

  it('flattened key sets are identical across locales', () => {
    const jaKeys = new Set(Object.keys(jaFlat));
    const enKeys = new Set(Object.keys(enFlat));

    const missingInEn = [...jaKeys].filter((k) => !enKeys.has(k)).sort();
    const missingInJa = [...enKeys].filter((k) => !jaKeys.has(k)).sort();

    expect(missingInEn, `keys present in ja but missing in en-US:\n  ${missingInEn.join('\n  ')}`).toEqual([]);
    expect(missingInJa, `keys present in en-US but missing in ja:\n  ${missingInJa.join('\n  ')}`).toEqual([]);
  });

  it('ICU placeholder names are consistent across locales (per key)', () => {
    const drifts: string[] = [];
    for (const [key, jaVal] of Object.entries(jaFlat)) {
      const enVal = enFlat[key];
      if (enVal == null) continue; // missing-key is handled by the prior test
      const jaPlaceholders = extractPlaceholders(jaVal);
      const enPlaceholders = extractPlaceholders(enVal);
      const onlyJa = [...jaPlaceholders].filter((n) => !enPlaceholders.has(n));
      const onlyEn = [...enPlaceholders].filter((n) => !jaPlaceholders.has(n));
      if (onlyJa.length || onlyEn.length) {
        drifts.push(
          `${key}: ja=[${[...jaPlaceholders].join(',')}] en-US=[${[...enPlaceholders].join(',')}]`,
        );
      }
    }
    expect(drifts, `placeholder drift:\n  ${drifts.join('\n  ')}`).toEqual([]);
  });

  it('every value is a non-empty string', () => {
    const empty: string[] = [];
    for (const [k, v] of Object.entries(jaFlat)) {
      if (typeof v !== 'string' || v.length === 0) empty.push(`ja:${k}`);
    }
    for (const [k, v] of Object.entries(enFlat)) {
      if (typeof v !== 'string' || v.length === 0) empty.push(`en-US:${k}`);
    }
    expect(empty).toEqual([]);
  });
});

describe('messages catalog — loader collision detection', () => {
  it('mergeMessagesStrict throws when two sources define the same top-level namespace', () => {
    expect(() =>
      mergeMessagesStrict([
        { source: 'a', messages: { foo: { a: 'A' } } },
        { source: 'b', messages: { foo: { b: 'B' } } },
      ]),
    ).toThrow(/namespace "foo" is defined in both "a" and "b"/);
  });

  it('mergeMessagesStrict succeeds when sources have disjoint namespaces', () => {
    const merged = mergeMessagesStrict([
      { source: 'a', messages: { foo: { x: '1' } } },
      { source: 'b', messages: { bar: { y: '2' } } },
    ]);
    expect(merged).toEqual({ foo: { x: '1' }, bar: { y: '2' } });
  });

  it('production main + sub-files for ja merge without collision', () => {
    expect(() =>
      mergeMessagesStrict([
        { source: 'ja.json', messages: jaMessages as AnyObject },
        { source: 'ja/email.json', messages: jaEmail as AnyObject },
        { source: 'ja/help.json', messages: jaHelp as AnyObject },
        { source: 'ja/guide.json', messages: jaGuide as AnyObject },
        { source: 'ja/faq.json', messages: jaFaq as AnyObject },
        { source: 'ja/superAdmin.json', messages: jaSuperAdmin as AnyObject },
      ]),
    ).not.toThrow();
  });

  it('production main + sub-files for en-US merge without collision', () => {
    expect(() =>
      mergeMessagesStrict([
        { source: 'en-US.json', messages: enMessages as AnyObject },
        { source: 'en-US/email.json', messages: enEmail as AnyObject },
        { source: 'en-US/help.json', messages: enHelp as AnyObject },
        { source: 'en-US/guide.json', messages: enGuide as AnyObject },
        { source: 'en-US/faq.json', messages: enFaq as AnyObject },
        { source: 'en-US/superAdmin.json', messages: enSuperAdmin as AnyObject },
      ]),
    ).not.toThrow();
  });
});

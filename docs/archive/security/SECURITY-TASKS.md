# SECURITY-TASKS.md
> 生成日時: 2026/5/1 16:18:54
> スクリプト: `tsx scripts/security-check.ts`
> 総合スコア: **94/100**
> 検出件数: CRITICAL 0 / HIGH 0 / MEDIUM 1 / LOW 0

## Claude Code への指示

このファイルはセキュリティチェックスクリプトが自動生成したタスクシートです。
以下の手順で修正を実施してください:

1. **優先度 HIGH 以上のタスクから順に対応** してください
2. 各タスクの「修正要件」と「修正後のコード例」に従って実装してください
3. **テスト要件は必須** です。テストなしの修正はコミットしないでください
4. 各タスク完了後に「完了条件」のチェックボックスを確認してください
5. 全タスク完了後に `tsx scripts/security-check.ts` を再実行し、スコアが改善されていることを確認してください

---

# ✅ CRITICAL / HIGH は検出されませんでした


# 📋 通常対応 (MEDIUM / LOW)

## F-01: MFA 暗号化キーが NEXTAUTH_SECRET から直接派生 (短い場合にゼロパディング)

**Severity**: MEDIUM
**Category**: CRYPTO
**File**: `src/services/mfa.service.ts` (line 9)

### 問題

NEXTAUTH_SECRET が 32 文字未満の場合、残りがゼロ文字で埋められ、予測可能なキーになります。また JWT 署名と暗号化キーが同一シークレット由来で用途分離が不十分です。

**問題のあるコード:**
```typescript
const ENCRYPTION_KEY = process.env.NEXTAUTH_SECRET?.slice(0, 32).padEnd(32, '0') || '0'.repeat(32);
```

### 修正要件

MFA 暗号化専用の環境変数 MFA_ENCRYPTION_KEY を追加してください。openssl rand -base64 32 で生成した 32 文字以上のランダム値を使用します。

**修正後のコード例:**
```typescript
// src/services/mfa.service.ts
const rawKey = process.env.MFA_ENCRYPTION_KEY;
if (!rawKey || rawKey.length < 32) {
  throw new Error('MFA_ENCRYPTION_KEY は 32 文字以上の環境変数を設定してください');
}
const ENCRYPTION_KEY = rawKey.slice(0, 32);

// .env.example に追加
// MFA_ENCRYPTION_KEY=  # openssl rand -base64 32 で生成
```

### テスト要件 (必須)

MFA_ENCRYPTION_KEY 未設定時にサーバー起動エラーになることをテストすること。MFA 登録→認証の E2E が通過すること。

### 完了条件

- [ ] 上記の修正要件を満たすコードが実装されている
- [ ] テスト要件を満たすテストコードが追加・通過している
- [ ] 同じパターンが他ファイルに横展開していないか検索済み
- [ ] `pnpm test` が全件通過している

---

# 📝 受容済み (Accept-list、score 計算対象外)

以下は `.security-check-acceptlist.json` で **設計判断として受容** している事項です。修正不要ですが、定期的な見直し対象として記録します。

## A-01: 本番環境でプレリリース版を使用: next-auth@5.0.0-beta.31

**Severity (元)**: HIGH
**Category**: DEP
**File**: `package.json`

### 受容理由
next-auth v5 は 2026-04-30 時点で stable 未リリース。NextAuth.js の公式案内通り beta を採用 (https://authjs.dev/getting-started/migrating-to-v5)。stable 公開後は速やかに移行。次回見直し: 月次 dependabot レビュー時。

### 元の問題説明
"next-auth@5.0.0-beta.31" はベータ/RC 版です。セキュリティパッチが正式版と異なるサイクルで提供されるため、未公表の脆弱性が放置されるリスクがあります。

---
## A-02: 本番 CSP の script-src に 'unsafe-inline' が残存

**Severity (元)**: MEDIUM
**Category**: CSP
**File**: `next.config.ts` (line 13)

### 受容理由
Next.js 16 + next-intl v4.x は SSR 時のクライアントハイドレーションでインラインスクリプト/スタイルを多数注入する。本番完全な nonce-based CSP に移行するには middleware.ts でリクエスト毎に nonce を生成し、Next.js の <Script> / <style> 全箇所に nonce を伝播させる大規模改修が必要 (公式 docs: https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy)。本対応は別 PR に分離。X-Frame-Options=DENY + frame-ancestors='none' で clickjacking 防御は維持済。

### 元の問題説明
'unsafe-inline' が有効だと XSS 攻撃者がインラインスクリプトを実行できます。CSP の XSS 防御効果が大幅に低下します。

---
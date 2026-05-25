# SECURITY-TASKS.md
> 生成日時: 2026/5/25 21:39:37
> スクリプト: `tsx scripts/security-check.ts`
> 総合スコア: **98/100**
> 検出件数: CRITICAL 0 / HIGH 0 / MEDIUM 0 / LOW 1

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

## F-01: セッション Cookie の SameSite が Strict でなく Lax

**Severity**: LOW
**Category**: AUTH
**File**: `src/lib/auth.config.ts` (line 63)

### 問題

SameSite=Lax は GET トップレベルナビゲーション時に Cookie を送信します。外部サイトからの誘導後も認証状態を維持する必要がなければ Strict が推奨です。

**問題のあるコード:**
```typescript
sameSite: 'lax',
```

### 修正要件

sameSite: 'strict' に変更してください。

**修正後のコード例:**
```typescript
sameSite: 'strict',
```

### テスト要件 (必須)

変更後にログインフロー（通常ログイン・MFA ログイン）の E2E テストが通過すること。

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
**File**: `next.config.ts` (line 39)

### 受容理由
Next.js 16 + next-intl v4.x は SSR 時のクライアントハイドレーションでインラインスクリプト/スタイルを多数注入する。本番完全な nonce-based CSP に移行するには middleware.ts でリクエスト毎に nonce を生成し、Next.js の <Script> / <style> 全箇所に nonce を伝播させる大規模改修が必要 (公式 docs: https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy)。本対応は別 PR に分離。X-Frame-Options=DENY + frame-ancestors='none' で clickjacking 防御は維持済。

### 元の問題説明
'unsafe-inline' が有効だと XSS 攻撃者がインラインスクリプトを実行できます。CSP の XSS 防御効果が大幅に低下します。

---
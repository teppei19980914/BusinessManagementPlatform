# ADR-0009: NextAuth.js (Credentials) + MFA (TOTP) を認証基盤に採用

- **Status**: Accepted
- **Date**: 2026-04 (MVP 認証設計時)
- **Deciders**: teppei

---

## Context

たすきば Knowledge Relay は業務情報を扱うため、認証は **B2B SaaS 相当のセキュリティ強度** が必要。
MVP 着手時点で検討した制約:

- **Next.js App Router との統合**: フロント / バックエンドが同一フレームワークのため、認証ライブラリも Next.js と整合性が高いものが望ましい
- **マルチテナント対応**: ログイン時点で `tenantId` を session に確立する必要がある ([ADR-0001](./0001-multitenant-foundation.md))
- **MFA (多要素認証) の要件**: admin ロールには MFA を強制したい (個人情報を扱うため)。一般ユーザも任意有効化できるべき
- **個人 / 少人数開発**: 認証バックエンドを自前構築する余裕はない。標準的なソリューションを採用したい
- **将来の OAuth 拡張余地**: 6/1 リリース時点では Credentials (email + password) のみで開始するが、将来 Google / Microsoft 等の OAuth プロバイダ追加を可能にしたい
- **セッション管理の中央集権化**: ログイン状態 / 失効 / 強制ログアウトを集中管理したい

## Decision

**NextAuth.js v5 (Credentials Provider) + TOTP ベース MFA** を採用する。

### 構成

| 要素 | 採用方式 |
|---|---|
| 認証ライブラリ | NextAuth.js v5 (Auth.js) |
| 第一要素 (パスワード) | Credentials Provider (email + password、bcrypt cost 12) |
| 第二要素 (MFA) | TOTP (Time-based One-Time Password、Google Authenticator 互換) |
| MFA 必須化 | admin ロールは必須、一般ユーザは任意 |
| セッション保持 | Cookie ベース (HttpOnly + Secure + SameSite=Strict) |
| パスワードリセット | リカバリーコード方式 (期限付きトークン経由) |

### 認証フロー

1. **ログイン要求**: `/api/auth/signin` で email + password を検証
2. **パスワード照合**: bcrypt で `users.password_hash` と比較
3. **アカウントロック判定**: `users.permanent_lock` / `temporary_lock_until` / failed count をチェック ([INCIDENT_RESPONSE.md §6.5](../operations/INCIDENT_RESPONSE.md))
4. **MFA 検証** (有効時): TOTP 6 桁コード入力 → `mfa.service.ts` の `resolveEncryptionKey` で復号した秘密鍵で検証
5. **session 確立**: `tenantId` / `userId` / `systemRole` / `mfaPassed` を JWT claim に格納
6. **監査ログ**: `auth_event_logs` に `event_type='login_success' / 'login_failure'` を記録

### MFA 仕様の詳細

- **秘密鍵の保管**: AES-256-GCM で暗号化して `users.mfa_secret_encrypted` に保存
- **暗号化キー**: `NEXTAUTH_SECRET` を派生鍵として使用 (v1)。将来 `MFA_ENCRYPTION_KEY` への分離を検討 ([docs/security/SECURITY-TASKS.md F-01](../security/SECURITY-TASKS.md))
- **失敗時の挙動**: 3 回連続失敗で 30 分の MFA ロック (パスワード系のロックとは独立)
- **リカバリ手段**: 事前に発行したリカバリコード (8 文字 × 10 個) 経由でロック解除

## Consequences

### Positive
- **標準ソリューションのため学習コスト・運用負荷が低い**: コミュニティ・ドキュメントが豊富
- **MFA の業界標準 TOTP**: Google Authenticator / Microsoft Authenticator / 1Password 等の既存アプリで利用可能、ユーザの追加学習不要
- **OAuth 拡張が容易**: NextAuth.js は Google / Microsoft / GitHub 等のプロバイダを設定追加だけで増やせる
- **`tenantId` の session 取り込み**: callback で柔軟にカスタマイズ可能
- **テスト容易性**: NextAuth の signIn / signOut を mock しやすい

### Negative / Trade-off
- **NextAuth.js v5 (Auth.js) は 2026 年時点でも比較的新しい**: v4 → v5 の breaking change を経験しており、メジャー更新時に追従コスト
- **Credentials Provider の落とし穴**: NextAuth 公式は「自前のユーザ DB を持つなら Credentials は最終手段」と推奨。OAuth / Magic Link 等の方が安全とされるが、本サービスは B2B SaaS 必須要件のため email+password が必要
- **MFA 秘密鍵の暗号化キー管理**: `NEXTAUTH_SECRET` 漏洩時の二重事故リスク。専用キー分離は post-MVP タスク (SECURITY-TASKS F-01)
- **MFA 必須範囲の判断**: 「admin だけ」が現状の方針だが、一般ユーザにも将来強制すべきかは継続検討

### Risk / 留意事項
- **fail-closed の徹底**: `NEXTAUTH_SECRET` 未設定時にデフォルト値で動作させない (`src/services/mfa.service.ts` で fail-closed 化済、PR security/auth-secret-hardening)
- **セッション固定攻撃対策**: NextAuth v5 は標準で対応済 (login 時にセッション ID 再生成)
- **CSRF 対策**: SameSite=Strict + CSRF token (NextAuth 標準) で防御
- **アカウントロック仕様の継続見直し**: パスワード 5 回失敗ロック / 3 回目で永続ロック等の現仕様は、運用後の悪用パターンに応じて調整

## Alternatives Considered

### Alt-1: Supabase Auth を採用
- 概要: Supabase 標準の認証機能 (Email + OAuth + Magic Link + MFA)
- メリット: DB と統合済、Magic Link が標準提供
- 不採用理由: (1) Supabase 固有機能を使うと AWS / Azure への移行時に再実装必要 ([ADR-0004](./0004-postgresql-prisma.md) の「Supabase 固有機能不使用」方針と矛盾) (2) アプリ層での認可カスタマイズ自由度が NextAuth より低い

### Alt-2: Clerk / Auth0 等の SaaS 認証
- 概要: 認証専用の SaaS (Clerk / Auth0 / Okta 等)
- メリット: 認証 UI / フロー / MFA / SSO が全部用意済、運用負荷ゼロ
- 不採用理由: (1) MAU 課金で初期コスト高 (Auth0 は ~7000 MAU 以上で有料) (2) ユーザデータが外部 SaaS に握られると将来の SaaS 移行コスト高 (3) 個人 / 少人数開発の MVP 段階では over-engineering

### Alt-3: SMS ベース MFA (TOTP の代わり)
- 概要: SMS で 6 桁コード送信
- メリット: ユーザがアプリインストール不要
- 不採用理由: (1) SMS 送信コスト発生 (1 送信 5-10 円) (2) SIM swap 攻撃に弱い (3) 海外ユーザ対応難 (4) 業界では TOTP の方が安全とされる

### Alt-4: WebAuthn / Passkey
- 概要: 端末の生体認証 / セキュリティキー
- メリット: フィッシング耐性が最強、パスワードレス
- 不採用理由: (1) ブラウザ / 端末対応がまだ十分でない (2) 紛失時のリカバリ設計が複雑 (3) 将来追加検討 (v2 以降)

### Alt-5: 自前認証実装 (NextAuth 不使用)
- 概要: bcrypt + jwt + cookie を自前で組み立て
- メリット: 完全な制御権
- 不採用理由: 認証は脆弱性混入リスクが最も高い領域。標準ライブラリを使わないのは合理的でない

## Related

- 詳細設計: [docs/design/SECURITY.md §8](../design/SECURITY.md)
- 認証イベント追跡: [docs/operations/INCIDENT_RESPONSE.md §6.5](../operations/INCIDENT_RESPONSE.md)
- アカウントロック仕様: [docs/business/USER_ROLES.md](../business/USER_ROLES.md)
- MFA 暗号化キー分離タスク: [docs/security/SECURITY-TASKS.md F-01](../security/SECURITY-TASKS.md)
- マルチテナント基盤: [ADR-0001](./0001-multitenant-foundation.md)
- 認可方式: [ADR-0005](./0005-rbac-two-stage-tenant-authorization.md)
- 外部参考: [NextAuth.js v5 (Auth.js) 公式ドキュメント](https://authjs.dev/) / [RFC 6238 TOTP](https://datatracker.ietf.org/doc/html/rfc6238)

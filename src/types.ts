/**
 * 共有型定義。
 */

/**
 * Worker の環境バインディング。wrangler.jsonc の bindings / vars / secrets に対応する。
 * `wrangler types` で worker-configuration.d.ts を生成すればより厳密になるが、
 * 生成に依存せず動くよう最小限をここでも定義しておく。
 */
export interface Env {
  /** McpAgent 用 Durable Object */
  MCP_OBJECT: DurableObjectNamespace;
  /** workers-oauth-provider のトークン/グラント保存用 KV */
  OAUTH_KV: KVNamespace;
  /** Google OAuth クライアント ID（secret） */
  GOOGLE_CLIENT_ID: string;
  /** Google OAuth クライアントシークレット（secret） */
  GOOGLE_CLIENT_SECRET: string;
  /** 承認 Cookie 暗号化鍵（secret） */
  COOKIE_ENCRYPTION_KEY: string;
  /** 要求する Google OAuth スコープ（空白区切り、vars で定義） */
  GOOGLE_OAUTH_SCOPES: string;
  /** workers-oauth-provider が注入するヘルパ */
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
}

/**
 * OAuth 完了時に McpAgent へ引き渡すユーザーコンテキスト（props）。
 * McpAgent のセッション(Durable Object)から `this.props` で参照できる。
 */
export interface Props {
  /** Google のユーザー ID（sub） */
  userId: string;
  /** 表示名 */
  name: string;
  /** メールアドレス */
  email: string;
  /** Google Health API を叩くためのアクセストークン */
  accessToken: string;
  /** アクセストークン更新用リフレッシュトークン（取得できた場合のみ） */
  refreshToken?: string;
  /** accessToken の失効エポック秒（概算） */
  expiresAt?: number;
  [key: string]: unknown;
}

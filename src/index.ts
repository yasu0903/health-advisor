/**
 * Worker エントリポイント。
 *
 * workers-oauth-provider が Worker を OAuth サーバー化し、
 *   - /sse, /mcp        → MCP エンドポイント（要認可）
 *   - /authorize, /token, /register → OAuth エンドポイント
 *   - defaultHandler(GoogleHandler) → 上流 Google OAuth (/authorize, /callback)
 * を束ねる。
 *
 * ローカル: `wrangler dev` (http://localhost:8787)
 * 本番:    `wrangler deploy`
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import GoogleHandler from "./google-handler.ts";
import { HealthMCP } from "./mcp.ts";

// McpAgent の Durable Object クラスを公開（wrangler.jsonc の class_name と一致）
export { HealthMCP };

export default new OAuthProvider({
  apiHandlers: {
    "/sse": HealthMCP.serveSSE("/sse"),
    "/mcp": HealthMCP.serve("/mcp"),
  },
  // @ts-expect-error Hono app は fetch ハンドラとして互換
  defaultHandler: GoogleHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

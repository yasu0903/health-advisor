/**
 * 上流(Google)の OAuth を処理するハンドラ。
 *
 * workers-oauth-provider の `defaultHandler` として登録され、以下を担う:
 *   GET /authorize  … Claude クライアントの認可要求を受け、Google の同意画面へリダイレクト
 *   GET /callback   … Google からの戻りを受け、code をトークンへ交換し、
 *                     ユーザー情報と Google トークンを props に載せて認可を完了させる
 *
 * 1回の Google ログインで「Claude ユーザーの識別」と
 * 「Google Health API アクセストークンの取得」を同時に行う。
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Env, Props } from "./types.ts";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

const app = new Hono<{ Bindings: Env }>();

/**
 * Claude クライアントからの認可要求。oauthReqInfo を state に載せて Google へ飛ばす。
 * （個人利用前提のため承認ダイアログは省略。必要なら approval 画面を挟める）
 */
app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthReqInfo.clientId) {
    return c.text("Invalid authorization request", 400);
  }

  const redirectUri = new URL("/callback", c.req.url).href;
  const state = btoa(JSON.stringify(oauthReqInfo));

  const authorizeUrl = new URL(GOOGLE_AUTHORIZE_URL);
  authorizeUrl.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: c.env.GOOGLE_OAUTH_SCOPES,
    // refresh_token を確実に得るため offline + consent を指定
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
  }).toString();

  return Response.redirect(authorizeUrl.href, 302);
});

/**
 * Google からのコールバック。code をトークンに交換し、認可を完了する。
 */
app.get("/callback", async (c) => {
  const stateParam = c.req.query("state");
  const code = c.req.query("code");
  const error = c.req.query("error");

  if (error) {
    return c.text(`Google OAuth error: ${error}`, 400);
  }
  if (!stateParam || !code) {
    return c.text("Missing state or code", 400);
  }

  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = JSON.parse(atob(stateParam)) as AuthRequest;
  } catch {
    return c.text("Invalid state", 400);
  }
  if (!oauthReqInfo.clientId) {
    return c.text("Invalid state (missing clientId)", 400);
  }

  const redirectUri = new URL("/callback", c.req.url).href;

  // code → トークン交換
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    return c.text(`Failed to exchange code: ${tokenRes.status} ${body}`, 502);
  }

  const token = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  // ユーザー情報取得（識別用）
  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!userRes.ok) {
    const body = await userRes.text();
    return c.text(`Failed to fetch userinfo: ${userRes.status} ${body}`, 502);
  }
  const user = (await userRes.json()) as {
    sub: string;
    name?: string;
    email?: string;
  };

  const props: Props = {
    userId: user.sub,
    name: user.name ?? user.email ?? user.sub,
    email: user.email ?? "",
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + (token.expires_in ?? 3600),
  };

  // 認可を完了し、Claude クライアントへ返す
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: user.sub,
    metadata: { label: props.name },
    scope: oauthReqInfo.scope,
    props,
  });

  return Response.redirect(redirectTo, 302);
});

export default app;

/**
 * Google Health API (https://health.googleapis.com/v4) の薄いクライアント。
 *
 * - 認証: Bearer アクセストークン。401 の場合はリフレッシュトークンで再取得して1回だけ再試行。
 * - 一時エラー(429/5xx): 指数バックオフでリトライ。
 * - レート制限は公式に非公開のため、控えめなリトライ設定にしている。
 *
 * データ取得はすべて次の形のエンドポイントに集約される:
 *   GET /v4/users/me/dataTypes/{dataType}/dataPoints:{method}
 * method は list / reconcile / rollUp / dailyRollUp のいずれか。
 *
 * NOTE: クエリパラメータ名(startTime/endTime 等)は Google Health API の
 * 公式リファレンスに合わせて調整可能なよう、呼び出し側から任意に渡せる設計にしている。
 * 実データで疎通確認する際はここのパラメータ名を必要に応じて見直すこと。
 */

const HEALTH_API_BASE = "https://health.googleapis.com/v4";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export type ReadMethod = "list" | "reconcile" | "rollUp" | "dailyRollUp";

export interface GoogleHealthClientOptions {
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  clientSecret: string;
  /** props に保存されたトークンが更新されたときに通知するコールバック（任意） */
  onTokenRefreshed?: (accessToken: string, expiresAt: number) => void;
}

export class GoogleHealthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "GoogleHealthError";
  }
}

export class GoogleHealthClient {
  private accessToken: string;
  private readonly refreshToken?: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly onTokenRefreshed?: (accessToken: string, expiresAt: number) => void;

  constructor(opts: GoogleHealthClientOptions) {
    this.accessToken = opts.accessToken;
    this.refreshToken = opts.refreshToken;
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.onTokenRefreshed = opts.onTokenRefreshed;
  }

  /**
   * 指定データ型を指定メソッドで読み取る。
   * @param dataType 例: "com.google.step_count.delta" 相当の Google Health データ型 ID
   * @param method   list / reconcile / rollUp / dailyRollUp
   * @param query    エンドポイントへ渡すクエリパラメータ
   */
  async readDataPoints(
    dataType: string,
    method: ReadMethod,
    query: Record<string, string> = {},
  ): Promise<unknown> {
    const params = new URLSearchParams(query);
    const qs = params.toString();
    const path = `/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints:${method}`;
    const url = `${HEALTH_API_BASE}${path}${qs ? `?${qs}` : ""}`;
    return this.request(url);
  }

  /** 任意の v4 相対パスに対する GET（拡張用） */
  async get(relativePath: string, query: Record<string, string> = {}): Promise<unknown> {
    const params = new URLSearchParams(query);
    const qs = params.toString();
    const url = `${HEALTH_API_BASE}${relativePath}${qs ? `?${qs}` : ""}`;
    return this.request(url);
  }

  private async request(url: string, attempt = 0): Promise<unknown> {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
      },
    });

    if (res.ok) {
      return res.json();
    }

    // 401: トークン失効の可能性 → リフレッシュして1回だけ再試行
    if (res.status === 401 && attempt === 0 && this.refreshToken) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        return this.request(url, attempt + 1);
      }
    }

    // 一時エラー: 指数バックオフでリトライ（最大3回）
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 2 ** attempt * 500;
      await sleep(backoffMs);
      return this.request(url, attempt + 1);
    }

    const body = await safeReadBody(res);
    throw new GoogleHealthError(
      `Google Health API request failed (${res.status} ${res.statusText})`,
      res.status,
      body,
    );
  }

  /** リフレッシュトークンで accessToken を更新。成功したら true。 */
  private async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshToken) return false;

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!res.ok) return false;

    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return false;

    this.accessToken = json.access_token;
    const expiresAt = nowSeconds() + (json.expires_in ?? 3600);
    this.onTokenRefreshed?.(json.access_token, expiresAt);
    return true;
  }
}

async function safeReadBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    try {
      return await res.text();
    } catch {
      return undefined;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

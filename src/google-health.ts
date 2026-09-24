/**
 * Google Health API (https://health.googleapis.com/v4) の薄いクライアント。
 *
 * - 認証: Bearer アクセストークン。401 の場合はリフレッシュトークンで再取得して1回だけ再試行。
 * - 一時エラー(429/5xx): 読み取りは指数バックオフでリトライ。書き込みはしない(後述)。
 * - レート制限は公式に非公開のため、控えめなリトライ設定にしている。
 *
 * エンドポイントは公式 discovery ドキュメント
 * (https://health.googleapis.com/$discovery/rest?version=v4) の定義に従う。
 * メソッドごとに HTTP メソッドとパラメータの渡し方が違う点に注意:
 *
 *   list        GET  .../dataTypes/{dataType}/dataPoints              ?filter=...
 *   reconcile   GET  .../dataTypes/{dataType}/dataPoints:reconcile    ?filter=...
 *   rollUp      POST .../dataTypes/{dataType}/dataPoints:rollUp       body {range, windowSize}
 *   dailyRollUp POST .../dataTypes/{dataType}/dataPoints:dailyRollUp  body {range, windowSizeDays}
 *   create      POST .../dataTypes/{dataType}/dataPoints              body DataPoint
 *
 * list だけはコロン付きサブメソッドではなく、コレクションへの素の GET である
 * (`dataPoints:list` というルートは存在せず 404 になる)。
 */

const HEALTH_API_BASE = "https://health.googleapis.com/v4";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export type ReadMethod = "list" | "reconcile" | "rollUp" | "dailyRollUp";

/** google.type.Interval 相当（物理時刻・start 含む / end 含まない） */
export interface Interval {
  startTime: string;
  endTime: string;
}

/** CivilDateTime 相当（タイムゾーンを持たない暦時刻） */
export interface CivilDateTime {
  date: { year: number; month: number; day: number };
}

/** CivilTimeInterval 相当（start 含む / end 含まない） */
export interface CivilTimeInterval {
  start: CivilDateTime;
  end: CivilDateTime;
}

/** 読み取り条件。メソッドごとに使うフィールドが異なる。 */
export interface ReadOptions {
  /** list / reconcile: AIP-160 のフィルタ式 */
  filter?: string;
  /** rollUp: 集計対象の物理時刻範囲 */
  range?: Interval;
  /** dailyRollUp: 集計対象の暦時刻範囲 */
  civilRange?: CivilTimeInterval;
  /** rollUp: 集計窓（google-duration, 例 "3600s"） */
  windowSize?: string;
  /** dailyRollUp: 集計窓（日数, 既定 1） */
  windowSizeDays?: number;
  /** 1 ページあたり件数。sleep / exercise は最大 25、その他は最大 10000。 */
  pageSize?: number;
  pageToken?: string;
  /** list 以外で指定可能なデータソース絞り込み */
  dataSourceFamily?: string;
}

/** リクエスト単位の挙動 */
interface RequestOptions {
  /** 429/5xx を指数バックオフで再試行するか（既定 true、書き込みは false） */
  retryTransient?: boolean;
}

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
   * メソッドごとに HTTP メソッド・パラメータ位置を discovery の定義に合わせて振り分ける。
   */
  async readDataPoints(
    dataType: string,
    method: ReadMethod,
    opts: ReadOptions = {},
  ): Promise<unknown> {
    const parent = `/users/me/dataTypes/${encodeURIComponent(dataType)}`;

    if (method === "list" || method === "reconcile") {
      const query: Record<string, string> = {};
      if (opts.filter) query.filter = opts.filter;
      if (opts.pageSize !== undefined) query.pageSize = String(opts.pageSize);
      if (opts.pageToken) query.pageToken = opts.pageToken;
      // dataSourceFamily は reconcile のみ受け付ける
      if (method === "reconcile" && opts.dataSourceFamily) {
        query.dataSourceFamily = opts.dataSourceFamily;
      }
      const suffix = method === "list" ? "/dataPoints" : "/dataPoints:reconcile";
      return this.requestJson("GET", `${parent}${suffix}`, query);
    }

    // rollUp / dailyRollUp は POST。範囲と集計窓はボディで渡す。
    const body: Record<string, unknown> = {};
    if (opts.pageSize !== undefined) body.pageSize = opts.pageSize;
    if (opts.pageToken) body.pageToken = opts.pageToken;
    if (opts.dataSourceFamily) body.dataSourceFamily = opts.dataSourceFamily;

    if (method === "rollUp") {
      if (!opts.range) throw new Error("rollUp には range が必要です");
      if (!opts.windowSize) throw new Error("rollUp には windowSize が必要です");
      body.range = opts.range;
      body.windowSize = opts.windowSize;
      return this.requestJson("POST", `${parent}/dataPoints:rollUp`, {}, body);
    }

    if (!opts.civilRange) throw new Error("dailyRollUp には civilRange が必要です");
    body.range = opts.civilRange;
    if (opts.windowSizeDays !== undefined) body.windowSizeDays = opts.windowSizeDays;
    return this.requestJson("POST", `${parent}/dataPoints:dailyRollUp`, {}, body);
  }

  /**
   * データポイントを 1 件作成する (users.dataTypes.dataPoints.create)。
   * レスポンスは長時間実行オペレーション形式の Operation。
   *
   * 一時エラーでの自動リトライはしない。書き込みを再送すると、実際には成功していた
   * 場合に二重登録になり得るため。呼び出し側で DataPoint.name を明示していれば
   * 同じ名前での再実行は冪等になるので、リトライは呼び出し側の判断に委ねる。
   */
  async createDataPoint(dataType: string, dataPoint: unknown): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints`,
      {},
      dataPoint,
      { retryTransient: false },
    );
  }

  /** 任意の v4 相対パスに対する GET（拡張用） */
  async get(relativePath: string, query: Record<string, string> = {}): Promise<unknown> {
    return this.requestJson("GET", relativePath, query);
  }

  private requestJson(
    httpMethod: "GET" | "POST",
    relativePath: string,
    query: Record<string, string> = {},
    body?: unknown,
    opts: RequestOptions = {},
  ): Promise<unknown> {
    const qs = new URLSearchParams(query).toString();
    const url = `${HEALTH_API_BASE}${relativePath}${qs ? `?${qs}` : ""}`;
    return this.request(httpMethod, url, body, opts);
  }

  private async request(
    httpMethod: "GET" | "POST",
    url: string,
    body?: unknown,
    opts: RequestOptions = {},
    attempt = 0,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(url, {
      method: httpMethod,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.ok) {
      return res.json();
    }

    // 401: トークン失効の可能性 → リフレッシュして1回だけ再試行
    if (res.status === 401 && attempt === 0 && this.refreshToken) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        return this.request(httpMethod, url, body, opts, attempt + 1);
      }
    }

    // 一時エラー: 指数バックオフでリトライ（最大3回）。書き込みは opts で無効化される。
    if ((opts.retryTransient ?? true) && (res.status === 429 || res.status >= 500) && attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 2 ** attempt * 500;
      await sleep(backoffMs);
      return this.request(httpMethod, url, body, opts, attempt + 1);
    }

    const detail = await safeReadBody(res);
    throw new GoogleHealthError(
      `Google Health API request failed (${res.status} ${res.statusText})`,
      res.status,
      detail,
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

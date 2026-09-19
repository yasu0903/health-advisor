/**
 * MCP サーバー本体。McpAgent(Durable Object) 上で読み取り専用ツールを公開する。
 *
 * ツールはすべて Google Health API の読み取りメソッド
 * (list / reconcile / rollUp / dailyRollUp) をラップしたもの。
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, Props } from "./types.ts";
import {
  GoogleHealthClient,
  GoogleHealthError,
  type CivilDateTime,
  type ReadMethod,
  type ReadOptions,
} from "./google-health.ts";

/**
 * データ型カタログ。dataType ID は公式 discovery ドキュメント
 * (https://health.googleapis.com/$discovery/rest?version=v4) の
 * DataPoint / RollupDataPoint / DailyRollupDataPoint の union フィールドと対応する。
 * URL パスでは kebab-case、フィルタ式では snake_case で参照される。
 */
interface DataTypeDef {
  /** ツール引数などで使う分かりやすいキー */
  key: string;
  /** Google Health API のデータ型 ID（URL パス用の kebab-case） */
  dataType: string;
  /** 説明 */
  description: string;
  /** サポートする読み取りメソッド */
  methods: ReadMethod[];
  /**
   * list / reconcile のフィルタ式で使う時間フィールドの種類。
   *   interval … {type}.interval.start_time     期間を持つデータ
   *   sample   … {type}.sample_time.physical_time  瞬間値のデータ
   *   sleep    … sleep.interval.end_time        睡眠は開始時刻で絞り込めない
   */
  timeField: "interval" | "sample" | "sleep";
  category: "activity" | "sleep";
}

const DATA_TYPES: DataTypeDef[] = [
  // --- アクティビティ全般 ---
  { key: "steps", dataType: "steps", description: "歩数", methods: ["list", "reconcile", "rollUp", "dailyRollUp"], timeField: "interval", category: "activity" },
  { key: "distance", dataType: "distance", description: "移動距離(m)", methods: ["list", "reconcile", "rollUp", "dailyRollUp"], timeField: "interval", category: "activity" },
  { key: "active-minutes", dataType: "active-minutes", description: "アクティブ時間(分)", methods: ["list", "reconcile", "rollUp", "dailyRollUp"], timeField: "interval", category: "activity" },
  { key: "total-calories", dataType: "total-calories", description: "総消費カロリー(kcal)", methods: ["rollUp", "dailyRollUp"], timeField: "interval", category: "activity" },
  { key: "active-energy-burned", dataType: "active-energy-burned", description: "活動による消費カロリー(kcal)", methods: ["list", "reconcile", "rollUp", "dailyRollUp"], timeField: "interval", category: "activity" },
  { key: "floors", dataType: "floors", description: "上った階数", methods: ["list", "reconcile", "rollUp", "dailyRollUp"], timeField: "interval", category: "activity" },
  { key: "heart-rate", dataType: "heart-rate", description: "心拍数(bpm)", methods: ["list", "reconcile", "rollUp", "dailyRollUp"], timeField: "sample", category: "activity" },
  { key: "time-in-heart-rate-zone", dataType: "time-in-heart-rate-zone", description: "心拍ゾーン滞在時間", methods: ["list", "reconcile", "rollUp", "dailyRollUp"], timeField: "interval", category: "activity" },
  { key: "calories-in-heart-rate-zone", dataType: "calories-in-heart-rate-zone", description: "心拍ゾーン別消費カロリー", methods: ["rollUp", "dailyRollUp"], timeField: "interval", category: "activity" },
  { key: "vo2-max", dataType: "vo2-max", description: "VO2 Max", methods: ["list", "reconcile"], timeField: "sample", category: "activity" },
  // --- 睡眠 ---
  { key: "sleep", dataType: "sleep", description: "睡眠ログ(睡眠ステージ含む)", methods: ["list", "reconcile"], timeField: "sleep", category: "sleep" },
];

/** 日次サマリで集計する対象 */
const DAILY_SUMMARY_KEYS = ["steps", "distance", "total-calories", "active-minutes", "floors"] as const;

/** sleep / exercise はページサイズ上限が 25、その他は 10000。 */
const MAX_PAGE_SIZE_SESSION = 25;

function findDataType(key: string): DataTypeDef | undefined {
  return DATA_TYPES.find((d) => d.key === key || d.dataType === key);
}

/** RFC3339 の日付(YYYY-MM-DD) */
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 形式で指定してください");

/** RFC3339 の日時 */
const dateTimeSchema = z
  .string()
  .describe("RFC3339 形式の日時 (例: 2026-09-18T00:00:00Z)");

/**
 * AIP-160 のフィルタ式を組み立てる。範囲は start 含む / end 含まない。
 * フィールド名は snake_case（例: heart-rate → heart_rate.sample_time.physical_time）。
 */
function buildFilter(def: DataTypeDef | undefined, dataTypeId: string, startTime: string, endTime: string): string {
  const field = (def?.dataType ?? dataTypeId).replace(/-/g, "_");
  const kind = def?.timeField ?? "interval";
  const path = kind === "sleep"
    ? `${field}.interval.end_time`
    : kind === "sample"
      ? `${field}.sample_time.physical_time`
      : `${field}.interval.start_time`;
  return `${path} >= "${startTime}" AND ${path} < "${endTime}"`;
}

/** YYYY-MM-DD → CivilDateTime */
function toCivilDateTime(date: string): CivilDateTime {
  const [year, month, day] = date.split("-").map(Number);
  return { date: { year, month, day } };
}

/** YYYY-MM-DD に日数を加算（UTC 基準） */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export class HealthMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({
    name: "Health Advisor (Google Health API)",
    version: "1.0.0",
  });

  /** props と env から Google Health クライアントを組み立てる */
  private client(): GoogleHealthClient {
    return new GoogleHealthClient({
      accessToken: this.props.accessToken,
      refreshToken: this.props.refreshToken,
      clientId: this.env.GOOGLE_CLIENT_ID,
      clientSecret: this.env.GOOGLE_CLIENT_SECRET,
      onTokenRefreshed: (accessToken, expiresAt) => {
        // セッション内で更新後トークンを保持
        this.props.accessToken = accessToken;
        this.props.expiresAt = expiresAt;
      },
    });
  }

  async init(): Promise<void> {
    // 1. 利用可能なデータ型一覧（Claude が正しい dataType を選べるように）
    this.server.tool(
      "list_available_data_types",
      "取得可能な健康データ型(アクティビティ/睡眠)と、各データ型がサポートする読み取りメソッドの一覧を返す。",
      {},
      async () => jsonResult({ dataTypes: DATA_TYPES }),
    );

    // 2. 日次アクティビティサマリ（主力ツール）
    this.server.tool(
      "get_daily_activity_summary",
      "指定期間の日次アクティビティサマリ(歩数・距離・消費カロリー・アクティブ時間・階数)を dailyRollUp で取得する。",
      {
        startDate: dateSchema.describe("開始日 (YYYY-MM-DD, 含む)"),
        endDate: dateSchema.describe("終了日 (YYYY-MM-DD, 含む)"),
      },
      async ({ startDate, endDate }) => {
        const client = this.client();
        // API の range は end を含まないため、終了日の翌日を渡す
        const civilRange = {
          start: toCivilDateTime(startDate),
          end: toCivilDateTime(addDays(endDate, 1)),
        };
        const results: Record<string, unknown> = {};
        for (const key of DAILY_SUMMARY_KEYS) {
          const def = findDataType(key);
          if (!def) continue;
          try {
            results[key] = await client.readDataPoints(def.dataType, "dailyRollUp", {
              civilRange,
              windowSizeDays: 1,
            });
          } catch (err) {
            results[key] = errorToObject(err);
          }
        }
        return jsonResult({ startDate, endDate, summary: results });
      },
    );

    // 3. 任意アクティビティデータの取得（柔軟）
    this.server.tool(
      "get_activity_datapoints",
      "任意のアクティビティ系データ型を取得する。intraday の生データは list、複数ソース統合は reconcile を使う。dataType は list_available_data_types で確認できる。",
      {
        dataType: z.string().describe("データ型のキーまたは ID (例: steps, heart-rate)"),
        startTime: dateTimeSchema.describe("開始日時 (RFC3339, 含む)"),
        endTime: dateTimeSchema.describe("終了日時 (RFC3339, 含まない)"),
        method: z
          .enum(["list", "reconcile", "rollUp", "dailyRollUp"])
          .default("reconcile")
          .describe("読み取りメソッド。既定は reconcile(重複排除済み統合)"),
        windowSize: z
          .string()
          .optional()
          .describe("rollUp の集計窓 (例: 3600s)。既定は 3600s"),
      },
      async ({ dataType, startTime, endTime, method, windowSize }) => {
        const def = findDataType(dataType);
        const resolvedType = def?.dataType ?? dataType;
        if (def && !def.methods.includes(method)) {
          return jsonResult({
            error: `データ型 '${def.key}' はメソッド '${method}' をサポートしません。対応メソッド: ${def.methods.join(", ")}`,
          });
        }
        return this.read(def, resolvedType, method, startTime, endTime, windowSize);
      },
    );

    // 4. 心拍データ
    this.server.tool(
      "get_heart_rate",
      "指定期間の心拍数データを取得する。詳細は list、時間窓集計は rollUp。",
      {
        startTime: dateTimeSchema.describe("開始日時 (RFC3339, 含む)"),
        endTime: dateTimeSchema.describe("終了日時 (RFC3339, 含まない)"),
        method: z.enum(["list", "rollUp"]).default("list").describe("既定は list(詳細)"),
        windowSize: z
          .string()
          .optional()
          .describe("rollUp の集計窓 (例: 3600s)。既定は 3600s"),
      },
      async ({ startTime, endTime, method, windowSize }) => {
        const def = findDataType("heart-rate")!;
        return this.read(def, def.dataType, method, startTime, endTime, windowSize);
      },
    );

    // 5. 睡眠ログ
    this.server.tool(
      "get_sleep_logs",
      "指定期間の睡眠ログ(睡眠ステージ含む)を取得する。",
      {
        startDate: dateSchema.describe("開始日 (YYYY-MM-DD, 含む)"),
        endDate: dateSchema.describe("終了日 (YYYY-MM-DD, 含む)"),
      },
      async ({ startDate, endDate }) => {
        const def = findDataType("sleep")!;
        // 睡眠は「起床時刻(interval.end_time)」でしか絞り込めない。
        // 終了日を含めるため、翌日 00:00 を排他的な上限として渡す。
        return this.read(
          def,
          def.dataType,
          "list",
          `${startDate}T00:00:00Z`,
          `${addDays(endDate, 1)}T00:00:00Z`,
        );
      },
    );
  }

  /** 共通の読み取り+エラーハンドリング */
  private async read(
    def: DataTypeDef | undefined,
    dataTypeId: string,
    method: ReadMethod,
    startTime: string,
    endTime: string,
    windowSize?: string,
  ): Promise<CallToolResult> {
    try {
      const opts: ReadOptions = {};
      if (method === "list" || method === "reconcile") {
        opts.filter = buildFilter(def, dataTypeId, startTime, endTime);
        if (def?.timeField === "sleep") opts.pageSize = MAX_PAGE_SIZE_SESSION;
      } else if (method === "rollUp") {
        opts.range = { startTime, endTime };
        opts.windowSize = windowSize ?? "3600s";
      } else {
        opts.civilRange = {
          start: toCivilDateTime(startTime.slice(0, 10)),
          end: toCivilDateTime(addDays(endTime.slice(0, 10), 1)),
        };
        opts.windowSizeDays = 1;
      }
      const data = await this.client().readDataPoints(dataTypeId, method, opts);
      return jsonResult(data);
    } catch (err) {
      return jsonResult(errorToObject(err));
    }
  }
}

type CallToolResult = { content: Array<{ type: "text"; text: string }> };

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorToObject(err: unknown): Record<string, unknown> {
  if (err instanceof GoogleHealthError) {
    return { error: err.message, status: err.status, detail: err.detail };
  }
  if (err instanceof Error) {
    return { error: err.message };
  }
  return { error: String(err) };
}

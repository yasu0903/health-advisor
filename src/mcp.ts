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
import { GoogleHealthClient, GoogleHealthError, type ReadMethod } from "./google-health.ts";

/**
 * データ型カタログ。
 *
 * ⚠️ ここの dataType 文字列は Google Health API の公式リファレンス
 *    (https://developers.google.com/health/reference/rest) に合わせて確定させること。
 *    実データ疎通時に不一致があればこの表を修正するだけで全ツールに反映される。
 *    `list_available_data_types` ツールでこの表を Claude 側にも公開する。
 */
interface DataTypeDef {
  /** ツール引数などで使う分かりやすいキー */
  key: string;
  /** Google Health API のデータ型 ID */
  dataType: string;
  /** 説明 */
  description: string;
  /** サポートする読み取りメソッド */
  methods: ReadMethod[];
  category: "activity" | "sleep";
}

const DATA_TYPES: DataTypeDef[] = [
  // --- アクティビティ全般 ---
  { key: "steps", dataType: "steps", description: "歩数", methods: ["list", "reconcile", "rollUp", "dailyRollUp"], category: "activity" },
  { key: "distance", dataType: "distance", description: "移動距離(m)", methods: ["list", "reconcile", "rollUp", "dailyRollUp"], category: "activity" },
  { key: "active-minutes", dataType: "active-minutes", description: "アクティブ時間(分)", methods: ["rollUp", "dailyRollUp"], category: "activity" },
  { key: "total-calories", dataType: "total-calories", description: "総消費カロリー(kcal)", methods: ["rollUp", "dailyRollUp"], category: "activity" },
  { key: "active-calories", dataType: "active-calories", description: "活動による消費カロリー(kcal)", methods: ["rollUp", "dailyRollUp"], category: "activity" },
  { key: "floors", dataType: "floors", description: "上った階数", methods: ["rollUp", "dailyRollUp"], category: "activity" },
  { key: "heart-rate", dataType: "heart-rate", description: "心拍数(bpm)", methods: ["list", "reconcile", "rollUp"], category: "activity" },
  { key: "heart-rate-zones", dataType: "heart-rate-zones", description: "心拍ゾーン", methods: ["rollUp", "dailyRollUp"], category: "activity" },
  { key: "vo2-max", dataType: "vo2-max", description: "VO2 Max", methods: ["list", "reconcile"], category: "activity" },
  // --- 睡眠 ---
  { key: "sleep", dataType: "sleep", description: "睡眠ログ(睡眠ステージ含む)", methods: ["list", "reconcile"], category: "sleep" },
];

/** 日次サマリで集計する対象 */
const DAILY_SUMMARY_KEYS = ["steps", "distance", "total-calories", "active-minutes", "floors"] as const;

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
        const results: Record<string, unknown> = {};
        for (const key of DAILY_SUMMARY_KEYS) {
          const def = findDataType(key);
          if (!def) continue;
          try {
            results[key] = await client.readDataPoints(def.dataType, "dailyRollUp", {
              startDate,
              endDate,
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
        endTime: dateTimeSchema.describe("終了日時 (RFC3339, 含む)"),
        method: z
          .enum(["list", "reconcile", "rollUp", "dailyRollUp"])
          .default("reconcile")
          .describe("読み取りメソッド。既定は reconcile(重複排除済み統合)"),
      },
      async ({ dataType, startTime, endTime, method }) => {
        const def = findDataType(dataType);
        const resolvedType = def?.dataType ?? dataType;
        if (def && !def.methods.includes(method)) {
          return jsonResult({
            error: `データ型 '${def.key}' はメソッド '${method}' をサポートしません。対応メソッド: ${def.methods.join(", ")}`,
          });
        }
        const query: Record<string, string> = method === "dailyRollUp"
          ? { startDate: startTime.slice(0, 10), endDate: endTime.slice(0, 10) }
          : { startTime, endTime };
        return this.read(resolvedType, method, query);
      },
    );

    // 4. 心拍データ
    this.server.tool(
      "get_heart_rate",
      "指定期間の心拍数データを取得する。詳細は list、時間窓集計は rollUp。",
      {
        startTime: dateTimeSchema.describe("開始日時 (RFC3339)"),
        endTime: dateTimeSchema.describe("終了日時 (RFC3339)"),
        method: z.enum(["list", "rollUp"]).default("list").describe("既定は list(詳細)"),
      },
      async ({ startTime, endTime, method }) => {
        const def = findDataType("heart-rate")!;
        return this.read(def.dataType, method, { startTime, endTime });
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
        // 睡眠は日付範囲を日時範囲に展開して list で取得
        return this.read(def.dataType, "list", {
          startTime: `${startDate}T00:00:00Z`,
          endTime: `${endDate}T23:59:59Z`,
        });
      },
    );
  }

  /** 共通の読み取り+エラーハンドリング */
  private async read(
    dataType: string,
    method: ReadMethod,
    query: Record<string, string>,
  ): Promise<CallToolResult> {
    try {
      const data = await this.client().readDataPoints(dataType, method, query);
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

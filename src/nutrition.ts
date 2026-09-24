/**
 * 食事ログ(nutrition-log)の書き込み用ヘルパ。
 *
 * Google Health API の `nutrition-log` は **セッション型** のデータ型で、
 * `users.dataTypes.dataPoints.create` (POST) で登録する。
 * 必要スコープは `googlehealth.nutrition.writeonly`。
 *
 * NutritionLog の作成方法は 2 通りある (discovery の NutritionLog の説明より):
 *   1. identified food … `food` に Food リソース名を渡す。栄養素は Food 側から自動補完される。
 *   2. anonymous food  … `foodDisplayName` と栄養素(energy/nutrients 等)を手で埋める。
 * v4 には Food を検索・作成するメソッドが無いため、実質 2 が主経路になる。
 * なお **anonymous food で作成したログは後から編集できない**(削除は可能)。
 */

import { z } from "zod";

/** Google Health API のデータ型 ID */
export const NUTRITION_LOG_DATA_TYPE = "nutrition-log";

/**
 * 食事カテゴリ。discovery の NutritionLog.mealType の enum から
 * MEAL_TYPE_UNSPECIFIED を除いたもの。
 * 公式説明で案内されているのは BREAKFAST / LUNCH / DINNER / SNACK の 4 つ。
 */
export const MEAL_TYPES = [
  "BREAKFAST",
  "LUNCH",
  "DINNER",
  "SNACK",
  "BEFORE_BREAKFAST",
  "BEFORE_LUNCH",
  "BEFORE_DINNER",
  "AFTER_DINNER",
  "ANYTIME",
] as const;

/** 栄養素の種類。discovery の NutrientQuantity.nutrient の enum から UNSPECIFIED を除いたもの。 */
export const NUTRIENTS = [
  "PROTEIN",
  "DIETARY_FIBER",
  "SUGAR",
  "SODIUM",
  "CARBOHYDRATES",
  "CHOLESTEROL",
  "SATURATED_FAT",
  "UNSATURATED_FAT",
  "MONOUNSATURATED_FAT",
  "POLYUNSATURATED_FAT",
  "TRANS_FAT",
  "CAFFEINE",
  "CALCIUM",
  "IRON",
  "MAGNESIUM",
  "PHOSPHORUS",
  "POTASSIUM",
  "ZINC",
  "COPPER",
  "CHLORIDE",
  "CHROMIUM",
  "IODINE",
  "MANGANESE",
  "MOLYBDENUM",
  "SELENIUM",
  "BIOTIN",
  "FOLATE",
  "FOLIC_ACID",
  "NIACIN",
  "PANTOTHENIC_ACID",
  "RIBOFLAVIN",
  "THIAMIN",
  "VITAMIN_A",
  "VITAMIN_B6",
  "VITAMIN_B12",
  "VITAMIN_C",
  "VITAMIN_D",
  "VITAMIN_E",
  "VITAMIN_K",
] as const;

export type MealType = (typeof MEAL_TYPES)[number];
export type Nutrient = (typeof NUTRIENTS)[number];

/** オフセット付き RFC3339 日時。startUtcOffset が必須なので "Z" か "+09:00" 形式を要求する。 */
const OFFSET_DATETIME_RE =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const offsetDateTimeSchema = z
  .string()
  .regex(
    OFFSET_DATETIME_RE,
    'タイムゾーン付きの RFC3339 形式で指定してください (例: 2026-09-22T12:30:00+09:00 または 2026-09-22T03:30:00Z)',
  );

/** 食事ログの入力。ツール引数と 1:1 で対応する。 */
export interface MealLogInput {
  /** 食事をとった日時(タイムゾーン必須) */
  eatenAt: string;
  /** 食事にかけた時間(分)。0 なら開始=終了の瞬間ログになる。 */
  durationMinutes?: number;
  /** 食べ物の表示名(anonymous food の場合は必須) */
  foodName?: string;
  /** Food リソース名。指定すると identified food として登録され、栄養素は自動補完される。 */
  food?: string;
  mealType?: MealType;
  /** エネルギー(kcal) */
  calories?: number;
  /** 脂質由来のエネルギー(kcal) */
  caloriesFromFat?: number;
  /** 炭水化物(g) */
  carbsGrams?: number;
  /** 脂質(g) */
  fatGrams?: number;
  /** たんぱく質(g)。API には専用フィールドが無く nutrients[PROTEIN] として送る。 */
  proteinGrams?: number;
  /** その他の栄養素(g) */
  nutrients?: Array<{ nutrient: Nutrient; grams: number }>;
  /**
   * データポイント ID。指定すると作成先のリソース名を自前で決められるため、
   * 同じ ID での再実行が冪等になる(二重登録を避けられる)。
   * 4-63 文字の小文字英数字とハイフンのみ。
   */
  dataPointId?: string;
}

/** dataPointId の書式(discovery の DataPoint.name の説明より) */
const DATA_POINT_ID_RE = /^[a-z0-9-]{4,63}$/;

export const dataPointIdSchema = z
  .string()
  .regex(DATA_POINT_ID_RE, "4-63 文字の小文字英数字とハイフンのみ使用できます");

/** RFC3339 のオフセット("Z" / "+09:00") を秒に変換 */
function offsetToSeconds(offset: string): number {
  if (offset === "Z") return 0;
  const sign = offset.startsWith("-") ? -1 : 1;
  const [hours, minutes] = offset.slice(1).split(":").map(Number);
  return sign * (hours * 3600 + minutes * 60);
}

/** google-duration 形式("32400s") へ。負のオフセットは "-18000s"。 */
function toGoogleDuration(seconds: number): string {
  return `${seconds}s`;
}

/**
 * ツール引数から create に渡す DataPoint を組み立てる。
 *
 * - `interval` は SessionTimeInterval。startTime/endTime は UTC に正規化し、
 *   ユーザーのローカル時刻とのずれを startUtcOffset/endUtcOffset で表現する。
 * - `dataSource.recordingMethod` は手入力なので MANUAL。
 *   platform / application は output only のため送らない。
 */
export function buildNutritionLogDataPoint(input: MealLogInput): Record<string, unknown> {
  const match = OFFSET_DATETIME_RE.exec(input.eatenAt);
  if (!match) {
    throw new Error(
      `eatenAt はタイムゾーン付きの RFC3339 形式で指定してください: ${input.eatenAt}`,
    );
  }
  if (!input.food && !input.foodName) {
    throw new Error("foodName(または Food リソース名 food)のどちらかが必要です");
  }

  const durationMinutes = input.durationMinutes ?? 0;
  if (durationMinutes < 0) {
    throw new Error("durationMinutes には 0 以上を指定してください");
  }

  const startMs = Date.parse(input.eatenAt);
  if (Number.isNaN(startMs)) {
    throw new Error(`eatenAt を日時として解釈できません: ${input.eatenAt}`);
  }
  const endMs = startMs + durationMinutes * 60_000;
  const utcOffset = toGoogleDuration(offsetToSeconds(match[5]));

  const nutritionLog: Record<string, unknown> = {
    interval: {
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
      startUtcOffset: utcOffset,
      endUtcOffset: utcOffset,
    },
  };

  if (input.mealType) nutritionLog.mealType = input.mealType;

  if (input.food) {
    // identified food: 栄養素は参照先の Food から自動で埋まるので送らない
    nutritionLog.food = input.food;
  } else {
    nutritionLog.foodDisplayName = input.foodName;
    if (input.calories !== undefined) nutritionLog.energy = { kcal: input.calories };
    if (input.caloriesFromFat !== undefined) {
      nutritionLog.energyFromFat = { kcal: input.caloriesFromFat };
    }
    if (input.carbsGrams !== undefined) {
      nutritionLog.totalCarbohydrate = { grams: input.carbsGrams };
    }
    if (input.fatGrams !== undefined) nutritionLog.totalFat = { grams: input.fatGrams };

    const nutrients = [
      ...(input.proteinGrams !== undefined
        ? [{ nutrient: "PROTEIN" as Nutrient, grams: input.proteinGrams }]
        : []),
      ...(input.nutrients ?? []),
    ].map(({ nutrient, grams }) => ({ nutrient, quantity: { grams } }));
    if (nutrients.length > 0) nutritionLog.nutrients = nutrients;
  }

  const dataPoint: Record<string, unknown> = {
    nutritionLog,
    dataSource: { recordingMethod: "MANUAL" },
  };
  if (input.dataPointId) {
    dataPoint.name = dataPointName(input.dataPointId);
  }
  return dataPoint;
}

/** dataPointId から DataPoint のリソース名を組み立てる */
export function dataPointName(dataPointId: string): string {
  return `users/me/dataTypes/${NUTRITION_LOG_DATA_TYPE}/dataPoints/${dataPointId}`;
}

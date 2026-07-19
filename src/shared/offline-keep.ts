// 离线设备保留时长:预设值 + 分钟→毫秒换算(UI 下拉与 main registry 共用)。
//
// 持久化层只存**分钟数**(见 settings.ts 的 offlineKeepMinutes),0 = 从不删除。
// Infinity 只在 minutesToKeepMs 之后、registry 运行时内存在——绝不进 settings.json
// (JSON.stringify(Infinity) === "null",会损坏持久化)。

/** "从不删除"的分钟编码。 */
export const OFFLINE_KEEP_NEVER = 0

/** 默认保留时长(分钟);字段缺失/非法时回落到它。 */
export const OFFLINE_KEEP_DEFAULT_MINUTES = 60

/** 设置面板下拉的预设项(分钟);0 = 从不。顺序即 UI 展示顺序。 */
export const OFFLINE_KEEP_PRESETS: { minutes: number; labelKey: string }[] = [
  { minutes: 10, labelKey: 'settings.offlineKeep.min10' },
  { minutes: 30, labelKey: 'settings.offlineKeep.min30' },
  { minutes: 60, labelKey: 'settings.offlineKeep.hour1' },
  { minutes: 360, labelKey: 'settings.offlineKeep.hour6' },
  { minutes: 720, labelKey: 'settings.offlineKeep.hour12' },
  { minutes: 1440, labelKey: 'settings.offlineKeep.day1' },
  { minutes: OFFLINE_KEEP_NEVER, labelKey: 'settings.offlineKeep.never' }
]

/**
 * 分钟 → registry 用的保留毫秒。
 * - 0 → Infinity(永不删除)
 * - 合法正整数 → min * 60_000
 * - 非法(NaN / 负 / 小数 / undefined)→ 默认 60min 的毫秒(防御 C1:非法值不能静默变成"永不删除")
 */
export function minutesToKeepMs(minutes: number): number {
  if (minutes === OFFLINE_KEEP_NEVER) return Infinity
  if (Number.isInteger(minutes) && minutes > 0) return minutes * 60_000
  return OFFLINE_KEEP_DEFAULT_MINUTES * 60_000
}

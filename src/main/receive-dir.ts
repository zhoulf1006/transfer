// 接收文件夹:该往哪儿落、状态要不要改。
//
// **不碰文件系统**——目录能不能用由调用方探测后传进来。这么切有两个好处:
// ① 全部失效成因(目录没了/不可写/卷卸载/沙盒 bookmark 解析失败)进到这一层形态相同,
//    一个布尔就都覆盖了;② 这些状态在测试机上难复现,注入即可构造。
//
// 状态只有两项,且**不保留失效前的路径**(2026-08-23 用户裁定)。代价是告知里说不出
// 是哪个文件夹、目录恢复后也不能自动切回;换来的是没有"选了但现在用不了"这种中间态。

import { realpathSync, accessSync, constants } from 'node:fs'

/** 用户对接收文件夹的选择。 */
export interface ReceiveDirState {
  /** 用户选定的目录;null = 用系统下载目录(**不写死默认路径**,否则系统下载目录变更时会留下过期值) */
  chosen: string | null
  /** 有一条未读的「已改回默认」告知。持久化,不能只活在内存里(spec D3) */
  notice: boolean
}

export interface Resolution {
  /** 本次实际该往哪儿落 */
  dir: string
  /** 状态需要写回时给出新值;不需要改动时为 null */
  next: ReceiveDirState | null
}

export interface ChoiceResult {
  state: ReceiveDirState
  /** 目录确实变了。调用方据此决定要不要提示"旧文件仍在原处"——没变就别提 */
  changed: boolean
}

/**
 * 算出本次该用哪个目录。自定义目录不可用时退回默认并置告知标记(spec C 组)。
 *
 * `usable` 由调用方注入:同步返回该目录当前能否写入。
 */
export function resolveReceiveDir(
  state: ReceiveDirState,
  defaultDir: string,
  usable: (dir: string) => boolean
): Resolution {
  // 没有自定义目录时无从失效 —— 默认目录本身不可用是另一回事,由调用方兜底(spec C10)
  if (state.chosen === null) return { dir: defaultDir, next: null }
  if (usable(state.chosen)) return { dir: state.chosen, next: null }
  return { dir: defaultDir, next: { chosen: null, notice: true } }
}

/**
 * 用户在系统选择器里选定之后,算出新状态(spec A4/A5、D4)。
 *
 * 选中的正好是默认目录时视为恢复默认 —— 记成 `chosen: defaultDir` 会让"恢复默认"
 * 这个操作凭空出现在界面上,而它点了什么也不会发生。
 */
/**
 * 目录当前能不能写入。
 *
 * 这是**探测**不是决策——它碰文件系统,所以与 `resolveReceiveDir` 分开:后者靠注入这个
 * 结果来保持纯粹。全部失效成因(目录没了/权限不足/卷卸载/沙盒未授权)在这里都归结为 false。
 */
export function isDirWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 展示给用户看的路径:解开符号链接(spec F1/F2/F6)。
 *
 * 沙盒下 `app.getPath('downloads')` 返回容器内的 `.../Data/Downloads`,而那是一个指向
 * 真实 `~/Downloads` 的**符号链接**——文件本就落在用户的下载目录里,只有这个字符串
 * 在误导人。解开它,设置页显示的就是用户在 Finder 里能找到的位置。
 *
 * **只用于展示,不用于落盘**:经符号链接写进去落到的是同一个位置,改落盘路径没有收益,
 * 只会在沙盒下多出授权变数。
 *
 * 解不开时(路径不存在、断链、权限不足)原样返回——显示一个未解析的真路径,
 * 好过显示空白。
 */
export function displayPath(raw: string): string {
  try {
    return realpathSync(raw)
  } catch {
    return raw
  }
}

export function chooseDir(picked: string, defaultDir: string, prev: ReceiveDirState): ChoiceResult {
  const chosen = picked === defaultDir ? null : picked
  return {
    // 选定动作本身就说明用户读到了那条告知,所以一并清掉
    state: { chosen, notice: false },
    changed: chosen !== prev.chosen
  }
}

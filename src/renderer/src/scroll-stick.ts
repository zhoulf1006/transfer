/**
 * 消息流"贴底"判定与阈值。
 *
 * 背景:滚到底之后气泡还会继续长高——图片气泡要等缩略图加载完才知道高度,文件气泡要
 * 渲出进度条。只在消息条数变化时滚一次,滚到的是**旧的底部**,新内容在视口下方(这正是
 * "发文件和图片时不滚到最新"的成因;文本气泡高度当场确定,故不受影响)。
 *
 * 因此需要在内容尺寸变化时补滚,但**不能无条件补**:用户正翻历史时被硬拽回底部,比不滚
 * 更烦人。判据是"补滚前用户是否本来就在底部附近"。
 */

/** 距底部多少像素以内仍算"在底部"。留余量是因为新内容可能刚把视口顶开几像素。 */
export const STICK_THRESHOLD_PX = 24

/**
 * 当前是否应贴底(据此决定要不要在内容变高后补滚)。
 * @param scrollTop 当前滚动位置
 * @param clientHeight 视口高度
 * @param scrollHeight 内容总高
 */
export function shouldStickToBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number
): boolean {
  // 内容不足一屏时无从滚动,恒定视为贴底
  return scrollHeight - scrollTop - clientHeight <= STICK_THRESHOLD_PX
}

/**
 * 新消息到达时是否自动滚到底。**必须分方向**:
 * - `sent`(自己刚发的):无条件滚。用户刚做完动作,就该看到结果。
 * - `recv`(收到对方的):只在已贴底时滚。用户正翻历史时把他弹到底部,是实测确认过的
 *   现有毛病——多数聊天应用都不这么干。不滚时由"跳到最新"按钮上的圆点告知有新消息,
 *   否则新消息会静默到达、用户无从察觉。
 */
export function shouldAutoScrollOnNewMessage(
  direction: 'sent' | 'recv',
  stuckToBottom: boolean
): boolean {
  return direction === 'sent' || stuckToBottom
}

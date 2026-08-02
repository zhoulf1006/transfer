// 已知覆盖缺口:接线部分(MutationObserver / capture 阶段 load / 两个 effect 的配合)
// 无自动化覆盖 —— vitest 的 include 只匹配 src/**/*.test.ts,不含 .tsx,且 environment
// 为 node 无 DOM。补测条件:引入 jsdom 环境并把 include 扩到 .tsx 之后可对滚动行为写
// 组件测试。在此之前靠真机验证:发一张图片,断言视口停在最新气泡而非其上方。
import { test, expect, describe } from 'vitest'
import { shouldStickToBottom, STICK_THRESHOLD_PX } from './scroll-stick'

// 消息流的"贴底"判定(纯函数便于单测;接线部分见 App.tsx,无自动化覆盖)。
//
// 为什么需要它:滚动到底之后气泡还会继续长高——图片气泡要等缩略图加载完才知道高度,
// 文件气泡要渲出进度条。只按消息条数滚一次,滚到的是"旧的底部"。所以要在内容尺寸变化
// 时补滚,但**不能无条件补**:用户翻历史时被硬拽回底部比不滚更烦人。
describe('shouldStickToBottom', () => {
  test('正好在底部 → 贴底', () => {
    // scrollTop 400 + 视口 200 = 600 = 内容总高
    expect(shouldStickToBottom(400, 200, 600)).toBe(true)
  })

  test('距底部在阈值内(比如刚被新气泡顶开几像素)→ 仍算贴底', () => {
    expect(shouldStickToBottom(400 - STICK_THRESHOLD_PX + 1, 200, 600)).toBe(true)
  })

  test('用户明显往上翻了 → 不贴底,不能把他拽回来', () => {
    expect(shouldStickToBottom(100, 200, 600)).toBe(false)
  })

  test('内容不足一屏(无法滚动)→ 贴底', () => {
    // 内容 150 < 视口 200:scrollHeight 甚至可能小于 clientHeight
    expect(shouldStickToBottom(0, 200, 150)).toBe(true)
  })

  test('恰好在阈值边界外 → 不贴底(边界不含)', () => {
    expect(shouldStickToBottom(400 - STICK_THRESHOLD_PX - 1, 200, 600)).toBe(false)
  })
})

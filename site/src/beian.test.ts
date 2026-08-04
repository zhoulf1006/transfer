/**
 * 覆盖缺口(诚实标注,勿当作已覆盖):
 *
 * - **「抛错 → 构建真的失败」这一环没有自动化测试。** 这里只断言函数抛错;从抛错到
 *   astro build 退出码非 0 之间还隔着 Astro 的错误处理。补测条件:接入构建冒烟测试后可覆盖。
 *   当前靠命令行实测坐实——`PUBLIC_ICP_BEIAN='写错了' pnpm --dir site build` 退出码应为 1。
 * - **页脚渲染的一切**(哪些页面有、在同一行的什么位置、深浅色、窄屏堆叠)不在这一层。
 *   靠产物 grep 与浏览器渲染级实测,断言含阴性对照(不设变量时页脚高度必须与设了时一致)。
 * - **部署脚本的守卫与自检**(空目录、缺备案号、后端不可达)靠变异实测,无自动化。
 * - **正则接受的形态是从常识推的,不是穷举真实备案号得来的**:省份简称按 1-2 个汉字、
 *   数字按 4 位以上。若某个真实备案号不符,构建会失败且信息清晰,但这是已知假设而非已验事实。
 */
import { describe, expect, it } from 'vitest'
import { resolveIcpBeian } from './beian'

describe('resolveIcpBeian', () => {
  // 未配置 = 这不是国内那份构建(Cloudflare Pages 就不设这个变量),不渲染备案号
  it('未设置时返回 null,不报错', () => {
    expect(resolveIcpBeian(undefined)).toBeNull()
  })

  // CI 与托管平台常把「没填」的变量传成空串。当成非法值会让 .com 那侧莫名构建失败,
  // 所以空串与纯空白一律视同未设置。
  it('空串与纯空白视同未设置', () => {
    expect(resolveIcpBeian('')).toBeNull()
    expect(resolveIcpBeian('   ')).toBeNull()
    expect(resolveIcpBeian('\n\t')).toBeNull()
  })

  it('合法备案号原样返回', () => {
    expect(resolveIcpBeian('苏ICP备2025154241号-2')).toBe('苏ICP备2025154241号-2')
    expect(resolveIcpBeian('京ICP备12345678号')).toBe('京ICP备12345678号')
    expect(resolveIcpBeian('黑ICP备87654321号-11')).toBe('黑ICP备87654321号-11')
  })

  it('两端有空白的合法值会被去掉空白', () => {
    expect(resolveIcpBeian('  苏ICP备2025154241号-2  ')).toBe('苏ICP备2025154241号-2')
  })

  // 「可选」与「随便写什么都行」是两回事:写错的备案号是违规展示,
  // 静默放行等于把违规藏到线上,而线上没人会去看页脚。所以设了就必须合法,否则构建失败。
  it('设置了但格式非法时抛错,让构建失败', () => {
    expect(() => resolveIcpBeian('ICP备2025154241号')).toThrow(/备案号/) // 缺省份简称
    expect(() => resolveIcpBeian('苏ICP备号-2')).toThrow(/备案号/) // 缺数字
    expect(() => resolveIcpBeian('苏ICP2025154241号')).toThrow(/备案号/) // 缺“备”
    expect(() => resolveIcpBeian('苏ICP备2025154241')).toThrow(/备案号/) // 缺“号”
    expect(() => resolveIcpBeian('随便写点什么')).toThrow(/备案号/)
    expect(() => resolveIcpBeian('https://beian.miit.gov.cn/')).toThrow(/备案号/)
  })

  it('抛错信息里带上拿到的原值,便于定位是哪个环境配错了', () => {
    expect(() => resolveIcpBeian('写错了')).toThrow(/写错了/)
  })
})

# 用 CDP 验证渲染行为:四种会给出假绿的写法

通过 Electron 的远程调试端口(`--remote-debugging-port`)读渲染进程的真实状态,是验证 UI 行为
最直接的手段——比截图肉眼看可靠。但断言写不对时,它给出的绿**比截图更有欺骗性**,因为看起来
像"实测数据"。以下四种都实际发生过。

## 一:窗口被遮挡时 scroll 事件根本不派发

在被其他窗口盖住的 Electron 窗口里:

```js
el.scrollTo({ top: 200 })
// → el.scrollTop 确实变成 200
// → 但 scroll 事件监听器一次都没触发
```

Chromium 对不可见/被遮挡的窗口会节流合成器,`scrollTop` 这类 DOM 属性照常更新,
**依赖合成器派发的事件(scroll 等)不发**。于是"改了 scrollTop 但 React 状态没更新",
看起来像业务代码的 bug,实际是环境问题。

绕过它的诱惑很大也很致命:手动 `el.dispatchEvent(new Event('scroll'))` 能让监听器跑起来、
测试变绿——**但真实路径从未被验证过**。曾据此报告"修复已验证",而用户在 dev 里一试就是坏的。

**做法:验证前先把窗口调到前台**,并确认 `document.visibilityState === 'visible'`:

```bash
osascript -e 'tell application "System Events" to set frontmost of (first process whose name is "Electron") to true'
```

## 二:合成事件不触发 CSS `:hover`

`dispatchEvent(new MouseEvent('mouseover'))` 能触发 React 的 `onMouseEnter`(React 用根节点
委托,合成事件冒泡即可),但**触发不了 `:hover` 伪类**——伪类由浏览器按真实指针位置计算。

hover 样式若走 CSS class(而非 React state),必须用真实鼠标事件:

```js
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, buttons: 0 })
```

核对 `el.matches(':hover')` 为 true,再读 `getComputedStyle`。

## 三:改完 class 立刻读 computed style,读到的是过渡的起点

元素上有 `transition: background .16s` 时:

```js
el.className = 'jump vB'
getComputedStyle(el).backgroundColor   // 仍是 vA 的值
```

计算值在过渡期间是插值结果,`t≈0` 时等于旧值。连续切三个变体逐一读取,会得到三个一模一样的
颜色,看起来像"class 没生效",实际只是读早了。

**做法:改完等 > transition 时长再读**(250–400ms 足够),或临时把 transition 关掉。

## 四:断言"元素在 DOM 里"冒充"用户看得见"

```js
按钮可见: !!document.querySelector('button[aria-label]')   // 假绿
```

元素可以在 DOM 里、有非零尺寸,却被祖先裁剪、被遮挡、或定位到视口之外(坑一那个
`position: absolute` 的按钮正是如此)。这条断言在按钮完全不可见时照样绿。

**做法:断言几何关系**,拿元素与其滚动容器的 rect 比:

```js
const cr = container.getBoundingClientRect(), br = btn.getBoundingClientRect()
const 在视口内 = br.bottom <= cr.bottom + 1 && br.top >= cr.top - 1
```

再配一个位置量(如"距容器底多少 px")——内容长高时这个值**不变**,才证明它没跟着内容滚。

## 通用判据

对每条 CDP 断言问一句:**它在什么情况下会红?** 答不出来的就是嫌疑假绿。
"元素存在"、"属性有值"这类断言几乎永远为真,不构成验证。

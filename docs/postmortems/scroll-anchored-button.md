# 消息流里的「跳到最新」浮动按钮:三个看着对、实际错的写法

一枚固定浮在滚动区右下角的圆形按钮,写法上连踩三个坑。三个都编译通过、类型正确、
本地看不出问题,只有真机滚动或量几何才暴露。

## 坑一:`position: absolute` 在可滚动容器里是跟着内容滚的

```ts
// 错:滚上去之后按钮不见了
jumpBtn: { position: 'absolute', right: 18, bottom: 14, ... }
```

绝对定位的包含块是最近的**已定位祖先的内容盒(padding box)**,不是它的可视视口。
消息流容器 `overflow-y: auto` 且 `position: relative`,于是 `bottom: 14` 量的是
**内容底部往上 14px**——内容有 1800px 高时,按钮就钉在 1800px 处,用户往上翻它就滚出视口。

两个症状其实是同一个根因:
- 「往上翻之后按钮没出现」——它在视口下方;
- 「按钮从上面滚下来」——快滚到底时它才进入视口。

正确写法是 `sticky` + 负 margin 抵消占位(项目里 `dropHint` 早就是这么写的):

```ts
jumpBtn: { position: 'sticky', bottom: 14, alignSelf: 'flex-end', marginBottom: -36, ... }
```

`marginBottom: -36`(等于自身高度)让它不在流中占位,视觉上纯浮于内容之上。

## 坑二:flex column 会把固定尺寸的子元素压扁

设了 `width: 36, height: 36, borderRadius: '50%'`,渲出来却是**椭圆**——实测
`getBoundingClientRect()` 高度只有 20px。

消息流是 `display: flex; flex-direction: column`,flex 子项默认 `flex-shrink: 1`,
主轴(column 下是高度)在内容溢出时会被压缩。`height: 36` 只是基准值,不是下限。

```ts
jumpBtn: { ..., flexShrink: 0 }   // 不能省
```

**这个坑只在内容溢出时出现**:消息少的时候按钮是正圆的,一旦聊天记录变长就变扁。

## 坑三:React 内联样式混用 `border` 简写与 `borderColor` 长写,边框会消失

```ts
jumpBtn:      { ..., border: '1px solid var(--line)' },        // 简写
jumpBtnHover: { ..., borderColor: 'var(--accent)' },           // 长写
```

hover 进出时 React 在两个 style 对象之间 diff,移除 `borderColor` 时会把
`border` 简写展开出的**所有长写属性一起清成空串**。DOM 上直接可见:

```
border-top-style: ; border-top-width: ; border-right-style: ; ...
```

结果是边框宽度归零/颜色回落到 `currentColor`,视觉上边框莫名其妙没了或变成深色。

两条出路,选后者:

- 全部用长写(`borderWidth` / `borderStyle` / `borderColor`),简写长写不混用;
- **hover 整体交给 CSS class**(项目既有约定,见 `theme.css` 的 `.tf-row` / `.tf-icon-btn`),
  内联只留几何与定位。注意此时**背景、阴影这类 hover 要改的属性必须整组放进 class**:
  内联样式优先级高于 class,base 值若写内联会把 `:hover` 规则压住,hover 直接不生效。

## 一个连带的教训:变量名写错不报错

第一版用了 `var(--surface)` / `var(--fg)` / `var(--border)`,**这三个变量在 `theme.css` 里根本不存在**
(正确的是 `--card` / `--ink-2` / `--line`)。CSS 变量查不到不会报错,只会静默回落:
背景解析成透明、`border-color` 回落到 `currentColor`。

代价是排查时会以为是布局问题。改样式后**量一次 `getComputedStyle` 的实际颜色值**比肉眼看快得多。

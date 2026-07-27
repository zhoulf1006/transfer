# 高 DPI:两类 canvas 不能用同一套 dpr 惯例

> 领域:截图标注 · Retina/高 DPI 屏

## 症状

Retina 上底图放大 2 倍、只显示左上 1/4 且发糊。

## 根因

双层 canvas 里两层性质不同,却被套了同一套 dpr 惯例:

- **标注层**画的是矢量元素、存逻辑坐标 —— 要按 dpr 惯例:`canvas.width = cssW × dpr` + `style.width = cssW` + `ctx.scale(dpr, dpr)`,线条才清晰;
- **底图层**内容本身就是**物理像素位图** —— **绝不能套 dpr scale**。套了等于把物理位图再放大一次,于是只看见左上 1/4。

## 做法

底图层:`canvas.width = bitmapW`、`style.width = bitmapW/dpr`、`drawImage` 源=目标 1:1 贴;或干脆用一张 `<img>` 铺背景不进 canvas。显示层按 dpr、导出层按原图物理尺寸,**两套坐标别混**。

## 连带的坑:长度量也要 × ratio

导出到物理位图时,不只坐标(x/y/w/h/points)要换算,**长度量**也必须换算——线宽、字号、箭头头长、序号圆半径。否则 Retina 下线只有一半粗、字只有一半小。

- 等比时用 `ratio`;
- 非等比时线宽/字号取 `Math.min(ratioX, ratioY)`,避免各向异性;
- `lineWidth` / `font` 要在**离屏导出 ctx** 上换算后再设,不能沿用显示 ctx 的值。

## 另一处

实测 ratio 要**用两轴分别算**,不能直接取 `scaleFactor`。

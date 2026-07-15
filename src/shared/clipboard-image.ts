/**
 * 从剪贴板 items 里挑出"图片文件"项(粘贴发图用)。
 *
 * 判定:kind==='file' 且 MIME type 以 'image/' 开头(png/jpeg/gif/webp 等一网打尽)。
 * 抽成纯函数便于单测——只吃 {kind,type} 形状,不依赖 DataTransferItem/DOM。
 * 调用方据返回的下标取对应 item 调 getAsFile()。
 */
export interface ClipboardItemLike {
  kind: string
  type: string
}

/** 返回 items 中"是图片文件"的项的下标(保序);无图片返回空数组。 */
export function pickImageItemIndices(items: readonly ClipboardItemLike[]): number[] {
  const out: number[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind === 'file' && it.type.startsWith('image/')) out.push(i)
  }
  return out
}

#!/bin/bash
# 造一份「测试静音」的 Electron dist 副本:Info.plist 加 LSUIElement=true。
#
# 为什么改 plist 而不是 JS:Dock 图标在 Electron **原生引导期**就按 plist 注册了,
# app.dock.hide() 要到几百毫秒后的主进程 JS 才执行——每个实例都"闪现→消失",
# e2e 的一串实例连着跑就是 Dock 持续抖动。LSUIElement=true 让它从注册那一刻
# 起就是 UIElement(无 Dock 图标、无菜单栏),不存在闪现窗口期。
#
# 用法(复制进项目后):e2e 在 playwright globalSetup、smoke 在脚本内,先跑本脚本,
# 再设 ELECTRON_OVERRIDE_DIST_PATH(以及 electron-vite 场景另需 ELECTRON_EXEC_PATH,
# 见 electron-scaffold skill 的 electron-testing.md 第 2 节)。
#
# 不动原件:副本放 node_modules/.cache/electron-quiet/,测试经
# ELECTRON_OVERRIDE_DIST_PATH 指过来(electron/index.js 原生支持);
# 正常 pnpm dev 与打包版仍走原件,Dock 行为不变。
#
# 幂等 + 版本感知:副本版本与原件一致且 plist 已含标记 → 直接退出;
# Electron 升级后自动重建。仅 macOS 需要;其他平台空操作。
set -euo pipefail
[ "$(uname)" = "Darwin" ] || exit 0
cd "$(dirname "$0")/.."

SRC=node_modules/electron/dist
DST=node_modules/.cache/electron-quiet/dist
PLIST="$DST/Electron.app/Contents/Info.plist"

[ -f "$SRC/version" ] || { echo "quiet-electron: 找不到 $SRC/version(electron 未安装?)" >&2; exit 1; }

# 快路径判据含完成标记:标记在**全部步骤成功后**才落——否则 codesign 若在
# plist 写入之后失败,下次快路径拿版本+plist 判"已就绪",会永远放行一份
# 签名无效的副本(arm64 直接起不来),且没人知道要去删缓存。
if [ -f "$DST/.quiet-ok" ] && [ "$(cat "$DST/version")" = "$(cat "$SRC/version")" ] \
   && /usr/libexec/PlistBuddy -c "Print :LSUIElement" "$PLIST" >/dev/null 2>&1; then
  exit 0
fi

rm -rf "$DST"
mkdir -p "$(dirname "$DST")"
# APFS 写时复制,秒级近零磁盘;非 APFS 卷退回普通拷贝
cp -Rc "$SRC" "$DST" 2>/dev/null || cp -R "$SRC" "$DST"

/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$PLIST"

# 改了 plist 即破签名封条;arm64 要求有效(至少 adhoc)签名,原件本就是 adhoc。
# 不吞 stderr:set -e 下失败要带着原因死,而不是静默留半成品
codesign --force -s - "$DST/Electron.app"

touch "$DST/.quiet-ok"   # 完成标记最后落,快路径以它为准
echo "quiet-electron: 副本就绪($(cat "$DST/version"))"

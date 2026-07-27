# 未读计数的三个 React/平台陷阱

> 领域:未读角标 · React StrictMode / effect 依赖 / Electron 平台差异

## 一、StrictMode 双调致未读翻倍

**症状**:对方发 1 条,未读显示 2。

**根因**:`setUnread` 被写在 `setMessages` 的 updater 内部,而 React StrictMode 下 updater 会被**调用两次**(用于暴露非纯函数)。计数因此翻倍。

**做法**:用 `seenIdsRef` 判"首见"做幂等,不依赖"updater 只跑一次"这个错误假设。

## 二、清零 effect 的依赖不能只写"最小集"

**症状**:app 在后台收到消息后,点 Dock 呼出窗口,角标不清零。

**根因**:清零 effect 的依赖只写了 `[peer, view]`。而"后台 → 呼出"这条路径里 peer 和 view **都没变**,effect 不重跑,清零逻辑压根没执行。

**做法**:依赖须为 `[peer, view, focused, peerUnread]`,且 `focused` 必须是 **state**(不能只有 ref)才能驱动重渲染。

**通用教训**:effect 依赖要**由场景推导**(哪些路径会导致该逻辑需要重跑),不由"写最少的依赖"推导。

## 三、`flashFrame` 在 mac 会让 Dock 持续跳

**根因**:名字看起来是"闪一下任务栏",mac 上的实际行为是 **Dock 图标持续弹跳**,不会自己停。

**做法**:`platform === 'win32'` 门控,mac 走数字角标(`setBadgeCount`)。

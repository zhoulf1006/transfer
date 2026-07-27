// 派生文件:由 sync-mmd.mjs 从本目录 *.mmd 生成,勿手改;改图请改 .mmd 后重跑脚本。
window.MERMAID_SOURCES = window.MERMAID_SOURCES || {};
window.MERMAID_SOURCES["transfer-chat/message-state"] = [
  {
    "title": "接收文件消息(面板驾驶对象)",
    "src": "%% title: 接收文件消息(面板驾驶对象)\n%%{init: {\n  'theme': 'base',\n  'htmlLabels': false,\n  'state': { 'htmlLabels': false },\n  'flowchart': { 'htmlLabels': false },\n  'themeVariables': {\n    'primaryColor': '#ECECFF',\n    'primaryBorderColor': '#D5D5FF',\n    'primaryTextColor': '#000000',\n    'lineColor': '#757575',\n    'textColor': '#212121',\n    'edgeLabelBackground': 'transparent',\n    'noteBkgColor': '#FFF6B8',\n    'noteBorderColor': '#E4C800',\n    'noteTextColor': '#5C5100',\n    'tertiaryColor': '#f5f5f5',\n    'background': '#FFFFFF'\n  }\n}}%%\nstateDiagram-v2\n    [*] --> pending : 收到 prepare-upload(需确认)\n    [*] --> accepted : 自动接收命中(size ≤ 阈值)\n    pending --> accepted : 用户点接收\n    pending --> rejected : 用户点拒绝\n    pending --> expired : 确认超时 T_ACCEPT / 重启恢复\n    accepted --> accepted : 传输进度(节流推送,不改状态)\n    accepted --> done : 落盘完成(填 filePath)\n    accepted --> failed : 落盘失败(errorReason)\n    done --> [*]\n    failed --> [*]\n    rejected --> [*]\n    expired --> [*]\n    note right of pending\n        终态后一切事件静默忽略\n        (原型将忽略外显为提示)\n    end note"
  },
  {
    "title": "发送消息(对照,面板未驱动)",
    "src": "%% title: 发送消息(对照,面板未驱动)\n%%{init: {\n  'theme': 'base',\n  'htmlLabels': false,\n  'state': { 'htmlLabels': false },\n  'flowchart': { 'htmlLabels': false },\n  'themeVariables': {\n    'primaryColor': '#ECECFF',\n    'primaryBorderColor': '#D5D5FF',\n    'primaryTextColor': '#000000',\n    'lineColor': '#757575',\n    'textColor': '#212121',\n    'edgeLabelBackground': 'transparent',\n    'noteBkgColor': '#FFF6B8',\n    'noteBorderColor': '#E4C800',\n    'noteTextColor': '#5C5100',\n    'tertiaryColor': '#f5f5f5',\n    'background': '#FFFFFF'\n  }\n}}%%\nstateDiagram-v2\n    [*] --> pending : 入库并入队(同 peer 串行)\n    pending --> done : 发送成功\n    pending --> rejected : 对方拒绝\n    pending --> failed : 离线(不触网) / busy / 超时 / 证书不匹配 / 网络错误"
  }
];

// 原型注册表:画廊壳(index.html)的数据源。生成原型追加一条,删除原型删对应条目。
// 条目 schema:{module, type:'ui'|'logic', id, name, path}——内容(问题/图/命令)都在各原型页内,此处只登记。
window.PROTOTYPES = [
  {
    module: 'transfer-chat', type: 'ui', id: 'main-window',
    name: '主界面(双栏)',
    path: 'transfer-chat/prototype-main-window.html'
  },
  {
    module: 'transfer-chat', type: 'ui', id: 'jump-to-latest',
    name: '跳到最新按钮(染色玻璃深浅)',
    path: 'transfer-chat/prototype-jump-to-latest.html'
  },
  {
    module: 'transfer-chat', type: 'logic', id: 'message-state',
    name: '消息状态机',
    path: 'transfer-chat/message-state/index.html'
  },
  {
    module: 'general', type: 'ui', id: 'settings',
    name: '设置弹层(单列分区)',
    path: 'general/prototype-settings.html'
  }
]

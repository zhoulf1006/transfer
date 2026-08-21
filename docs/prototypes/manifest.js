// 原型注册表:画廊壳(index.html)的数据源。生成原型追加一条,删除原型删对应条目。
// 条目 schema:{module, type:'ui'|'logic', id, name, path}——内容(问题/图/命令)都在各原型页内,此处只登记。
window.PROTOTYPES = [
  {
    module: 'transfer-chat', type: 'ui', id: 'main-window',
    name: '主界面(双栏)',
    path: 'transfer-chat/prototype-main-window.html'
  },
  {
    module: 'transfer-chat', type: 'ui', id: 'file-type-icons',
    name: '文件类型图标(选型)',
    path: 'transfer-chat/prototype-file-type-icons.html'
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
  },
  {
    module: 'screenshot', type: 'ui', id: 'annotation-toolbar',
    name: '标注工具条(图标选型)',
    path: 'screenshot/prototype-annotation-toolbar.html'
  },
  {
    module: 'landing-page', type: 'ui', id: 'footer-beian',
    name: '页脚备案号(国内镜像)',
    path: 'landing-page/prototype-footer-beian.html'
  }
]

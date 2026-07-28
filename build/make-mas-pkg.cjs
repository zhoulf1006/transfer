#!/usr/bin/env node
// 由 mas 构建产物打出 App Store 用的 .pkg,并用 3rd Party Mac Developer Installer 签名。
//
// 为什么不用 electron-builder 出 pkg:它的 `mas` 目标映射成 NoOpTarget,只签 .app、不产
// pkg(见 app-builder-lib 的 macPackager 目标 mapper);而 `pkg` 目标是独立的普通 mac
// 目标,`--mac mas pkg` 会让它去包 **darwin 那份 Developer ID 构建**——实测产出的 pkg 里
// 装的是 com.loong.transfer、无沙盒、无内嵌 profile,传上去必被拒。故改用 Apple 原生
// productbuild,输入显式指向 mas 产物。
//
// 用法:pnpm run dist:mas 之后跑 pnpm run pkg:mas
// 覆盖:MAS_APP=<路径> PKG_OUT=<路径> INSTALLER_IDENTITY=<身份>

const { execFileSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { join, dirname } = require('node:path')

const version = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version
const appPath =
  process.env.MAS_APP || join(__dirname, '..', 'release', version, 'mas-universal', 'Transfer.app')
const outPath =
  process.env.PKG_OUT || join(dirname(appPath), '..', `Transfer-${version}-mas-universal.pkg`)

if (!existsSync(appPath)) {
  console.error(`找不到 mas 产物:${appPath}\n先跑 pnpm run dist:mas`)
  process.exit(1)
}

// 装错 app 是这条链路最隐蔽的失败:pkg 能正常生成、上传才报错。故在打包前先断言产物身份。
function assertMasApp() {
  const out = execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', appPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  if (!out.includes('com.apple.security.app-sandbox')) {
    throw new Error('该 .app 未启用 App Sandbox —— 多半指向了 Developer ID 构建而非 mas 产物')
  }
  if (!existsSync(join(appPath, 'Contents', 'embedded.provisionprofile'))) {
    throw new Error('该 .app 无内嵌 provisioning profile —— 不是 mas 产物')
  }
  const sig = execFileSync('codesign', ['-dv', '--verbose=2', appPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  // codesign 把详情写 stderr,上面已合并;两处都查以防实现变化
  const all = out + sig
  if (!/Apple Distribution/.test(all) && !/3rd Party Mac Developer Application/.test(all)) {
    console.warn('[pkg:mas] 警告:未在签名信息中看到 Apple Distribution,请确认这是发布构建')
  }
}

function findInstallerIdentity() {
  if (process.env.INSTALLER_IDENTITY) return process.env.INSTALLER_IDENTITY
  const out = execFileSync('security', ['find-identity', '-v'], { encoding: 'utf8' })
  const m = out.match(/"(3rd Party Mac Developer Installer: [^"]+)"/)
  if (!m) {
    throw new Error(
      '钥匙串中找不到 "3rd Party Mac Developer Installer" 身份。\n' +
        '注意 `security find-identity -v -p codesigning` 会把它过滤掉,查证书要用不带 -p 的版本。'
    )
  }
  return m[1]
}

assertMasApp()
const identity = findInstallerIdentity()
console.log(`[pkg:mas] app      = ${appPath}`)
console.log(`[pkg:mas] identity = ${identity}`)
execFileSync(
  'productbuild',
  ['--component', appPath, '/Applications', '--sign', identity, outPath],
  { stdio: 'inherit' }
)
console.log(`[pkg:mas] 已生成 ${outPath}`)

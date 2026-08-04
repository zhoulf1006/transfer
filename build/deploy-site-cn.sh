#!/usr/bin/env bash
# 把落地页部署到国内镜像 transfer.aloongplanet.com.cn(阿里云 ECS)。
#
#   pnpm deploy:site:cn
#
# .com 那份由 Cloudflare Pages 在 master 合并后自动构建部署,不经过本脚本。
# 两份的唯一差异是页脚的 ICP 备案号,由本脚本注入的构建期环境变量决定。

set -euo pipefail

# 备案号由脚本自己注入,不依赖使用者记得先 export ——
# 靠人记得的合规约束等于没有约束。它不是密钥,是这个域名的公开法定标识。
ICP_BEIAN='苏ICP备2025154241号-2'

# 服务器地址不写进仓库:这是公开仓库,硬编码等于对外公告该 IP 可以 root SSH。
# 从环境变量读;仓库根的 .deploy.env(已 gitignore)也会被读进来。
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
[ -f "$REPO_ROOT/.deploy.env" ] && . "$REPO_ROOT/.deploy.env"

HOST="${DEPLOY_HOST:?未设置 DEPLOY_HOST(形如 root@1.2.3.4)。放进 .deploy.env 或直接 export}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/aloongplanet_ecs}"
DEST=/srv/www/transfer
BACKEND_PORT=8081

[ -f "$KEY" ] || { echo "找不到部署密钥:$KEY" >&2; exit 1; }

echo "==> 构建(注入备案号)"
PUBLIC_ICP_BEIAN="$ICP_BEIAN" pnpm --dir "$REPO_ROOT/site" build

DIST="$REPO_ROOT/site/dist"
[ -f "$DIST/index.html" ] || { echo "构建产物里没有 index.html:$DIST" >&2; exit 1; }

# 构建期就把「漏注入」挡掉。备案号缺失是合规问题,不能等上线后靠人去看页脚才发现。
if ! grep -q "$ICP_BEIAN" "$DIST/index.html"; then
  echo "产物里找不到备案号,拒绝部署。构建过程可能没有拿到 PUBLIC_ICP_BEIAN。" >&2
  exit 1
fi

echo "==> 同步 $DIST/  ->  $HOST:$DEST/"
rsync -az --delete -e "ssh -i $KEY -o BatchMode=yes" "$DIST/" "$HOST:$DEST/"

# 权限必须在服务器侧修,不能用 rsync --chmod:macOS 自带的是 openrsync,不认那个参数。
# 而 ECS 默认 umask 027 会让新文件落成 640,反代容器里的 nginx(uid 101) 读不到,页面变 403。
echo "==> 修正权限并自检"
ssh -i "$KEY" -o BatchMode=yes "$HOST" "
  chmod -R a+rX $DEST
  docker exec nginx-app curl -s -o /dev/null -m 10 -w '    后端 HTTP %{http_code}\n' http://aloongplanet-static:$BACKEND_PORT/
  docker exec nginx-app curl -s -m 10 http://aloongplanet-static:$BACKEND_PORT/ | grep -q 'ICP备' \
    && echo '    线上页面已含备案号' \
    || { echo '    线上页面没有备案号' >&2; exit 1; }
"

echo "==> 完成:https://transfer.aloongplanet.com.cn"

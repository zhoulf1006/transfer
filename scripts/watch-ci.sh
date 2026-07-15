#!/usr/bin/env bash
# 轮询一次 GitHub Actions run 到完成,打印 conclusion + 各 job 结果。
#
# 为什么用轮询而非 `gh run watch --exit-status`:后者退出码在部分环境会误报成功/失败,
# 故只信 `gh run view --json status,conclusion`(实测可靠)。
#
# 用法:
#   scripts/watch-ci.sh              # 自动取最近一次 run
#   scripts/watch-ci.sh <run-id>     # 指定 run
#   INTERVAL=15 scripts/watch-ci.sh  # 自定义轮询间隔(秒,默认 30)
#
# 退出码:CI success → 0;失败/取消 → 1;脚本自身错误 → 2。
set -uo pipefail

REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null)" || {
  echo "取 repo 失败(gh 未登录或不在仓库内?)" >&2; exit 2; }

RUN_ID="${1:-}"
if [ -z "$RUN_ID" ]; then
  RUN_ID="$(gh run list --repo "$REPO" --limit 1 --json databaseId --jq '.[0].databaseId')" || {
    echo "取最近 run 失败" >&2; exit 2; }
fi

INTERVAL="${INTERVAL:-30}"
echo "轮询 CI run $RUN_ID (repo=$REPO, 每 ${INTERVAL}s)..."

# 最多轮询 ~40min(mac 公证档最慢),防脚本卡死。
for _ in $(seq 1 80); do
  RES="$(gh run view "$RUN_ID" --repo "$REPO" --json status,conclusion --jq '.status + "|" + (.conclusion // "")')" || {
    echo "查询 run 状态失败" >&2; exit 2; }
  STATUS="${RES%%|*}"
  CONCL="${RES##*|}"
  if [ "$STATUS" = "completed" ]; then
    echo ""
    echo "完成: conclusion=$CONCL"
    echo "--- 各 job ---"
    # gh 部分版本不支持 --json jobs;用文本视图 grep job 行(实测可靠)。
    gh run view "$RUN_ID" --repo "$REPO" 2>/dev/null | grep -E "^\s*[✓X✗].*(in [0-9])" || true
    [ "$CONCL" = "success" ] && exit 0 || exit 1
  fi
  sleep "$INTERVAL"
done

echo "超时:run 仍未完成(已轮询上限)" >&2
exit 2

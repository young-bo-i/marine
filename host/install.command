#!/bin/sh
# 双击我即可安装 Marine 的「本地智能体（Codex）」桥接，只需一次。
DIR=$(cd "$(dirname "$0")" && pwd)
sh "$DIR/install.sh"
echo ""
printf "按回车键关闭本窗口…"
read _

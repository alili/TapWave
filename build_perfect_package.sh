#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# 委托执行全自动化发布与打包脚本 (处理版本号升级、README记录、Tauri构建、DMG与ZIP生成及覆盖application目录)
node scripts/package.mjs "$@"

#!/usr/bin/env bash
# 构建 Windows 一键安装包（在 Linux / macOS 上即可完成，不需要 Windows 机器）
#
#   bash packaging/build-windows.sh
#
# 产物：dist/OCS-Setup-<版本>.exe
#
# 依赖：makensis（NSIS）、可选 x86_64-w64-mingw32-gcc（编译启动器）
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(cd .. && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
STAGING="staging"
DIST="$ROOT/dist"
NODE_VER="${NODE_VER:-v22.23.4}"
VENDOR="vendor"
NODE_EXE="$VENDOR/node.exe"

echo "==> 打包 ocs-server v$VERSION"

command -v makensis >/dev/null || { echo "缺少 makensis，请先安装 nsis"; exit 1; }

# ---------- 1. 准备 node.exe ----------
mkdir -p "$VENDOR"
if [ ! -f "$NODE_EXE" ]; then
  echo "==> 下载 Windows 版 Node $NODE_VER（只需一次，约 34MB）"
  TMP_ZIP="$VENDOR/node-win.zip"
  URL1="https://npmmirror.com/mirrors/node/$NODE_VER/node-$NODE_VER-win-x64.zip"
  URL2="https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-win-x64.zip"
  if ! curl -fL --max-time 600 -o "$TMP_ZIP" "$URL1"; then
    echo "    镜像失败，改用官方源"
    curl -fL --max-time 600 -o "$TMP_ZIP" "$URL2"
  fi
  rm -rf "$VENDOR/node-tmp"
  mkdir -p "$VENDOR/node-tmp"
  unzip -q -o "$TMP_ZIP" -d "$VENDOR/node-tmp"
  cp "$VENDOR/node-tmp/node-$NODE_VER-win-x64/node.exe" "$NODE_EXE"
  rm -rf "$VENDOR/node-tmp" "$TMP_ZIP"
fi
echo "    node.exe $(du -h "$NODE_EXE" | cut -f1)"

# ---------- 2. 组织安装目录 ----------
rm -rf "$STAGING" "$DIST"
mkdir -p "$STAGING/app/node_modules" "$DIST"

cp "$ROOT/launch.js" "$ROOT/package.json" "$STAGING/app/"
cp "$ROOT/README.md" "$STAGING/app/" 2>/dev/null || true
cp "$ROOT/AI答题说明.md" "$STAGING/app/" 2>/dev/null || true
cp -r "$ROOT/src" "$STAGING/app/src"
cp -r "$ROOT/userscript" "$STAGING/app/userscript"
cp -r "$ROOT/node_modules/playwright-core" "$STAGING/app/node_modules/playwright-core"
# 类型声明运行时用不到，省 2MB
rm -rf "$STAGING/app/node_modules/playwright-core/types"

cp "$NODE_EXE" "$STAGING/node.exe"
cp "ocs.ico" "$STAGING/ocs.ico"

# ---------- 3. 编译启动器 ----------
if [ -f launcher.res ] && [ -f "OCS网课助手.exe" ]; then
  echo "==> 复用已编译的启动器"
elif command -v x86_64-w64-mingw32-gcc >/dev/null; then
  echo "==> 编译 Windows 启动器"
  x86_64-w64-mingw32-windres launcher.rc -O coff -o launcher.res --codepage=65001
  # -mwindows：GUI 子系统，双击不弹控制台，程序常驻通知区域
  x86_64-w64-mingw32-gcc launcher.c launcher.res -o "OCS网课助手.exe" \
    -mwindows -lshell32 -luser32 -lgdi32 -lcomctl32 -finput-charset=UTF-8 -O2 -s
else
  echo "缺少 mingw-w64，无法编译启动器（请先跑一次编译，或安装 gcc-mingw-w64-x86-64）"
  exit 1
fi
cp "OCS网课助手.exe" "$STAGING/OCS网课助手.exe"

# ---------- 4. 出安装包 ----------
echo "==> 生成安装包"
makensis -V2 installer.nsi

echo ""
echo "==> 完成"
ls -lh "$DIST"/*.exe
echo ""
echo "安装包：$DIST/OCS-Setup-$VERSION.exe"

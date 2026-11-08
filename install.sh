#!/bin/sh
# WeChat-iLink Bridge（整合版）一键安装（Linux / macOS）
# 依次：检查环境 → 全局安装 wxb / wxb-mcp → 编译并安装 SILK 编码器 → 运行测试 → 自检
set -e
cd "$(dirname "$0")"

echo "==> 检查环境"
command -v node >/dev/null 2>&1 || { echo "错误：未找到 node（需要 >= 18）"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "错误：未找到 npm"; exit 1; }
for t in ffmpeg ffprobe; do
  command -v "$t" >/dev/null 2>&1 || echo "警告：未找到 $t（语音转码需要，可稍后自行安装）"
done
command -v make >/dev/null 2>&1 || { echo "错误：未找到 make（编译 SILK 编码器需要）"; exit 1; }
command -v g++ >/dev/null 2>&1 || command -v c++ >/dev/null 2>&1 || { echo "错误：未找到 C++ 编译器（编译 SILK 编码器需要 g++）"; exit 1; }

echo "==> 全局安装 wxb / wxb-mcp"
npm install -g .

echo "==> 编译 SILK 编码器（third_party/silk-v3-decoder）"
SILK_DIR="third_party/silk-v3-decoder/silk"
make -C "$SILK_DIR" >/dev/null
make -C "$SILK_DIR" encoder >/dev/null
[ -f "$SILK_DIR/encoder" ] || { echo "错误：SILK 编码器编译失败"; exit 1; }

INSTALL_DIR="${SILK_INSTALL_DIR:-/usr/local/bin}"
if cp "$SILK_DIR/encoder" "$INSTALL_DIR/silk-encoder" 2>/dev/null; then
  chmod +x "$INSTALL_DIR/silk-encoder"
  echo "silk-encoder 已安装到 $INSTALL_DIR/silk-encoder"
else
  mkdir -p "$HOME/.local/bin"
  cp "$SILK_DIR/encoder" "$HOME/.local/bin/silk-encoder"
  chmod +x "$HOME/.local/bin/silk-encoder"
  echo "警告：$INSTALL_DIR 不可写，silk-encoder 已装到 ~/.local/bin/silk-encoder"
  echo "      若该目录不在 PATH 中，请设置环境变量 WX_SILK_ENCODER_PATH=$HOME/.local/bin/silk-encoder"
fi

echo "==> 运行测试"
npm test

echo "==> 自检"
command -v wxb >/dev/null 2>&1 && echo "wxb: $(command -v wxb)"
command -v wxb-mcp >/dev/null 2>&1 && echo "wxb-mcp: $(command -v wxb-mcp)"
wxb help >/dev/null && echo "wxb help OK"
echo ""
echo "安装完成。下一步：wxb login --json 扫码登录，然后 wxb doctor 检查健康状态。"

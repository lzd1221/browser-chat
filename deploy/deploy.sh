#!/usr/bin/env bash
# browser-chat 一键部署脚本（Linux + systemd）
# 用法: sudo bash deploy/deploy.sh [端口]    默认端口 3000
set -euo pipefail

PORT="${1:-3000}"
APP_NAME="browser-chat"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_MAJOR_OK=18

echo "==> browser-chat 部署: 端口=${PORT} 目录=${APP_DIR}"

# 1) 检查/安装 Node.js (>=18)
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v | sed 's/^v//' | cut -d. -f1)"
  echo "   检测到 Node.js v$(node -v) (要求 >= ${NODE_MAJOR_OK})"
  if [ "$NODE_VER" -lt "$NODE_MAJOR_OK" ]; then
    echo "   Node 版本过低，将升级..."
    install_node=1
  else
    install_node=0
  fi
else
  echo "   未检测到 Node.js，开始安装..."
  install_node=1
fi

if [ "$install_node" = "1" ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  echo "   Node.js 安装完成: $(node -v)"
fi

# 2) 安装依赖
cd "$APP_DIR"
echo "==> 安装依赖 (npm install --omit=dev)"
npm install --omit=dev --no-fund --no-audit

# 3) 准备运行目录与数据目录
mkdir -p "$APP_DIR/data"
chmod 755 "$APP_DIR"

# 4) 写入 systemd 服务
SERVICE="/etc/systemd/system/${APP_NAME}.service"
echo "==> 写入 systemd 服务: ${SERVICE}"
cat > "$SERVICE" <<EOF
[Unit]
Description=Browser Chat (简洁浏览器聊天)
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=PORT=${PORT}
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${APP_NAME}" >/dev/null 2>&1 || true
systemctl restart "${APP_NAME}"

# 5) 验证
sleep 1
echo "==> 验证..."
if systemctl is-active --quiet "${APP_NAME}"; then
  echo "✅ ${APP_NAME} 已启动"
else
  echo "❌ 服务启动失败，最近日志："
  journalctl -u "${APP_NAME}" -n 40 --no-pager || true
  exit 1
fi
echo "服务状态:"
systemctl status "${APP_NAME}" --no-pager -l | head -n 12 || true
echo
echo "访问地址: http://<服务器IP>:${PORT}"
echo "提示: 若从公网访问，请在云控制台安全组放行 TCP ${PORT} 端口"

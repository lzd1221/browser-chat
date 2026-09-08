# 💬 Browser Chat — 简洁浏览器聊天应用

零构建的多人聊天应用：**账号注册 → 唯一 ID 登录 → 搜索 ID 加好友 → 实时聊天**。

- 昵称可以重名，**ID 唯一**（字母/数字/下划线，3–20 位）
- 好友请求制：搜到对方 ID → 发请求 → 对方同意后即可聊天
- 实时收发消息（WebSocket 推送）、在线状态、未读数、消息持久化
- **已读回执**：自己发出的消息气泡下实时显示「未读/已读」，对方打开聊天读取后自动更新
- **好友备注**：可给每个好友设置备注名（仅自己可见），列表与聊天头部优先显示备注
- 界面简洁：单页面，登录 / 注册 + 好友列表 + 聊天面板
- 技术栈：Node.js 原生 HTTP + `ws` + JSON 文件存储，**无构建步骤**

## 快速开始

```bash
npm install          # 安装依赖（仅 ws）
npm start            # 默认 http://localhost:3000
```

自定义端口：

```bash
PORT=8080 npm start
# Windows PowerShell: $env:PORT=8080; npm start
```

首次启动自动创建 `data/db.json`（用户与消息数据，已 gitignore，注意备份）。

## 部署（Linux 服务器 / systemd）

把仓库放到服务器后：

```bash
sudo bash deploy/deploy.sh 8080     # 8080 换成你想要对外提供服务的端口
```

脚本会：检查并安装 Node ≥ 18 → `npm install` → 写入 systemd 服务 `browser-chat` → 开机自启并立即启动。

常用命令：

```bash
systemctl status browser-chat       # 查看状态
systemctl restart browser-chat      # 重启
journalctl -u browser-chat -f       # 查看日志
```

## 使用说明

1. **注册**：设置唯一 ID（如 `alice_2024`）、昵称（可与其他用户相同）、密码。
2. **加好友**：左侧搜索框输入对方 **ID** → 点击「发送好友请求」；对方在「新的好友请求」里点「同意」。
3. **聊天**：点好友进入聊天，Enter 发送，Shift+Enter 换行；左侧显示未读消息数。

## API 一览

所有接口均为 JSON；除注册/登录外需请求头 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/register` | 注册 `{id, nickname, password}` → `{token, user}` |
| POST | `/api/login` | 登录 `{id, password}` → `{token, user}` |
| GET | `/api/me` | 当前用户信息 |
| GET | `/api/search?q=<id>` | 按 ID 精确搜索（返回 `user/isFriend/pending`） |
| GET | `/api/contacts` | 好友列表（在线/未读/最后消息）+ 收到的好友请求 |
| POST | `/api/friends/request` | 发送好友请求 `{to}` |
| POST | `/api/friends/respond` | 处理请求 `{from, accept}` |
| POST | `/api/friends/remark` | 设置好友备注 `{to, remark}`（remark 空则清除） |
| GET | `/api/messages?with=<id>` | 拉取聊天记录（自动标记已读） |
| POST | `/api/messages` | 发送消息 `{to, text}` |
| POST | `/api/read` | 标记与某好友的消息已读 `{with}` |
| WS | `/ws?token=<token>` | 实时推送：新消息 / 好友请求 / 同意 / 在线状态 / 已读回执 |

## 目录结构

```
browser-chat/
├── server.js          # 后端：HTTP API + WebSocket + JSON 持久化
├── public/            # 前端静态页面（无构建）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── deploy/deploy.sh   # Linux systemd 一键部署脚本
└── package.json
```

## 说明 / 限制

- 会话保存在服务端内存，服务重启后需重新登录（数据不丢）。
- 每对好友服务端保留最近 500 条消息，前端一次加载最近 100 条。
- 单机演示级实现：JSON 存储 + 内存会话，适合小型使用与试用；如需大规模生产，可换 SQLite/Postgres + 持久会话。

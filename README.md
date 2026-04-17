# 猎户座 Orion Desktop

> OpenClaw 控制面板 — 纯 React/Electron 实现，ClawX 界面克隆

## 产品定位

**猎户座 = OpenClaw 的安装器 + 状态仪表盘**

用户打开猎户座的那一刻，就是在安装和配置 OpenClaw。界面与 ClawX 完全一致，功能等同于 ClawX，但实现技术栈不同。

## 技术选型

| 组件 | 技术 |
|------|------|
| 界面框架 | React 19 + TypeScript |
| 桌面运行时 | Electron 40 |
| 构建工具 | Vite + electron-builder |
| UI 样式 | Tailwind CSS v3 + shadcn/ui |
| 状态管理 | Zustand |
| 国际化 | i18next |
| 图标 | Lucide React |

## 核心设计原则

### 1. 界面 = ClawX（像素级复制）
- 全部 UI 源码来自 ClawX（MIT 许可证）
- 不做任何自主设计决策
- 视觉差异 = Bug，必须修复

### 2. 功能 = OpenClaw 官方实现
- 不碰网关底层逻辑
- 所有写入操作经过 Gateway WebSocket API
- 只做界面搬运，不做功能修改

### 3. 只做按钮的搬运工
- Orion 是个壳，包裹着 OpenClaw
- 用户通过 Orion 触发 OpenClaw 官方功能
- 每个按钮都能找到对应的 Gateway API 调用

## 项目结构

```
clawx-ui/
├── electron/
│   ├── main.ts          # Electron 主进程 + IPC handlers
│   └── preload.ts       # 安全桥接 preload 脚本
├── src/
│   ├── pages/           # 页面组件（来自 ClawX 源码）
│   │   ├── Setup/       # Setup 向导（新用户安装流程）
│   │   ├── Chat/        # 聊天页面
│   │   ├── Models/      # 模型管理
│   │   ├── Agents/     # Agent 管理
│   │   ├── Channels/    # 频道管理
│   │   ├── Skills/      # Skills 管理
│   │   └── Settings/    # 设置页面
│   ├── stores/           # Zustand 状态管理
│   ├── lib/              # 库函数（Gateway WS、API client）
│   ├── components/       # 共享组件
│   └── i18n/            # 国际化（en/zh/ja/ru）
├── release/              # 构建输出
│   ├── linux-unpacked/  # 可直接运行的 unpacked 版本
│   └── *.deb            # Debian 安装包
└── build/               # 应用图标资源
```

## 开发

### 环境要求
- Node.js 20+
- npm 10+

### 常用命令

```bash
# 开发模式（热重载）
cd ~/projects/clawx-ui
npm run dev

# 构建 Web 前端
npm run build

# 打包 Electron 应用
npx electron-builder --dir    # 快速打包到 release/linux-unpacked/
npx electron-builder          # 完整打包（deb 等）

# 启动已打包的应用
cd release/linux-unpacked
./orion-ui --no-sandbox
```

### 启动参数
- `--no-sandbox` — Linux 沙盒兼容（必填）
- `--disable-gpu` — 禁用 GPU 加速（如有显示问题）

## 版本管理

使用 Git 标签管理版本：

```bash
git tag -a v0.2.0 -m "描述"
git push origin v0.2.0
```

查看所有版本：
```bash
git tag -l
git log --oneline --decorate
```

## Gateway 连接

- **WebSocket**: `ws://127.0.0.1:18789`
- **REST**: `http://127.0.0.1:18789`
- **Token**: 来自 `~/.openclaw/gateway-token`
- **clientId**: `openclaw-control-ui`
- **mode**: `webchat`

详见 [ARCHITECTURE.md](ARCHITECTURE.md)

## 已知限制

1. **无 sudo 安装** — 无法使用 dpkg 安装，必须手动解压 deb
2. **OAuth 未实现** — Provider OAuth 登录流程暂未支持
3. **写入操作** — 读取直接走 Gateway，写入经过 session 审核

## 更新日志

详见 [CHANGELOG.md](CHANGELOG.md)

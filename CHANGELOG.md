# 更新日志

所有重大变更都记录在此。按发布日期管理。

格式：
```
## [版本号] - YYYY-MM-DD

### 新增
### 修复
### 变更
### 技术
```

---

## [v0.1.0-baseline] - 2026-04-12

### 技术
- Setup 页面完全恢复为 ClawX 原始源码（1878 行，0 diff）
- 添加 `provider:validateKey` IPC handler（API key 验证）
- 添加 `uv:install-all` IPC handler（技能安装）
- 添加 `getDefaultBaseUrl()` 函数（各 provider 默认端点）

### 状态
- Orion 可正常启动，显示 ClawX 原始 Setup 向导界面
- Gateway WebSocket 连接正常
- Provider 选择页面可正常渲染

### 待修复
- Welcome 页面语言选择按钮行为待验证
- Runtime 检查页面调用 `gateway:status` 待确认
- Provider API key 验证实际调用效果待测试

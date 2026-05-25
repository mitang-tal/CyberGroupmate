# CyberGroupmate (赛博群友)

> **一个由代码驱动的群聊社交 Agent**

CyberGroupmate 是一个能够以自然、拟人的行为模式参与群聊的自主 AI Agent。基于 [CodeAct](https://arxiv.org/abs/2402.01030) 范式构建，该 Agent 通过编写并执行 TypeScript 代码和 Shell 命令来进行感知、推理和行动——而不是依赖死板的 Tool Call。

Join our discussion on Telegram! [https://t.me/cybergroupmate](https://t.me/cybergroupmate)

---

![CodeAct面板](docs/images/image1.png)
![LLM日志记录](docs/images/image2.png)
![记忆面板](docs/images/image3.png)


## ✨ 核心特性

* **“读空气”引擎（氛围感知）** — 智能的消息路由与话题级分类；确切知道何时该发言，何时该保持沉默。
* **自然的对话流** — 模拟人类回复延迟、优雅地退出话题。
* **主动话题介入** — Agent 能够在恰当的时候与恰当的人就恰当的话题进行互动。
* **三层记忆系统** — 基于 Recording Pipeline 的背景记忆管线。带来短期记忆压缩、中期情景/社交记忆，以及语义召回能力。
* **Main Agent/Sub Agent 架构** — 双层架构，Main Agent 负责宏观决策，Sub Agent 负责具体任务。→ 即将进化为三层架构，通过 Background Agent，让ta能处理更复杂的任务。 
* **反馈循环** — 追踪每次回复后群组的反应，并据此调整未来的行为模式。
* **CodeAct 执行机制** — Agent 会在沙盒环境中编写真实的 TypeScript 代码，从而实现灵活的多步推理与自我调试。
* **NPM As Skills** — 通过我们创新性的 [渐进式披露 in CodeAct 和 TS Skills 机制](docs/progressive-disclosure-in-codeact.md)，只需要引入新 NPM 包，选择你想要暴露的 API，编写少量示例代码，并加上你所需的安全策略，把 d.ts 塞进去就可以快速接入新的平台和技能。
* **反思引擎** — 由 LLM 周期性驱动的自我反思机制，用于巩固情景记忆、更新人物画像并提取核心事实。
* **原生多模态能力** — 支持图片、贴纸、视频、动图等媒体的识别与理解，根据模型能力，自动选择使用 Vision Agent 或直接使用主模型进行处理。
* **完善的可视化面板** — 我们始终将行为可视化与框架能力视为同等重要的开发事项，通过面板你能够实现几乎所有操作，实时看到并理解 Agent 如何决策、如何行动、执行了什么代码

当前支持平台：Discord、Telegram

## 🏗 系统架构​

请参考 [docs/architecture_v3.md](docs/architecture_v3.md) 获取详细信息。

也许您会更喜欢[直接阅读我们所有的 Prompts](system-prompts)，这是个好主意——我们对 Prompts 的更新频率远高于架构文档。事实上，架构文档不能完全反映当前的架构。我们总是有很多新想法在路上、在测试。

但也请注意，Protmps 不能完全反映我们的设计，所以最好结合着来看。

## 🖥️ 本机原生运行

原生运行不依赖 Docker，适合直接在 Linux 主机上常驻服务。运行时数据默认写入项目根目录下的 `workspace/`。

### 环境准备

需要 Node.js 22 或更新版本，以及用于编译 native npm 模块的基础工具：

```bash
# Debian/Ubuntu 示例
sudo apt-get update
sudo apt-get install -y nodejs npm python3 make g++ \
  ffmpeg zip unzip wget curl jq imagemagick git \
  poppler-utils dnsutils

# 推荐安装 uv；pandoc 仅在需要文档转换能力时安装
sudo apt-get install -y uv pandoc
```

如果机器无法直连 npm 官方源，可以临时使用可访问的镜像：

```bash
npm config set registry https://registry.npmmirror.com
```

### 安装与构建

```bash
# 1. 准备配置文件
cp config.example.yaml config.yaml
# 编辑 config.yaml，填写平台凭据、LLM API Key、Dashboard 等配置

# 2. 安装后端依赖
npm ci

# 3. 构建 Dashboard 静态资源
npm --prefix src/dashboard/ui ci
npm run dashboard:build

# 4. 启动
LOG_LEVEL=info npm start
```

启动后 Dashboard 默认监听 `config.yaml` 中配置的地址与端口；常见部署为 `http://<host>:6767`。

### systemd 常驻

生产环境建议用 systemd 托管进程。将 `WorkingDirectory` 和 `User` 改成实际部署路径与运行用户：

```ini
[Unit]
Description=CyberGroupmate native service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=aosc
Group=aosc
WorkingDirectory=/home/aosc/docker/CyberGroupmate
Environment=NODE_ENV=production
Environment=LOG_LEVEL=info
Environment=PATH=/usr/bin:/bin:/usr/sbin:/sbin
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=10
TimeoutStopSec=30
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
```

保存为 `/etc/systemd/system/cybergroupmate.service` 后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cybergroupmate.service
systemctl status cybergroupmate.service
journalctl -u cybergroupmate.service -f
```

### 原生运行数据

关键数据位于 `workspace/`，例如：

* `workspace/memory.db*`：记忆数据库及 WAL/SHM。
* `workspace/tg-session/`：Telegram userbot 登录会话。
* `workspace/sessions/`：Subagent/CodeAct 会话状态。
* `workspace/Downloads/`、`workspace/media/`：运行中保存和引用的媒体资产。
* `workspace/skills/`、`workspace/.local/`、`workspace/lib/`：Agent 技能和持久化运行环境。

备份或迁移时，通常可以排除这些可再生成的缓存目录：

```text
workspace/media-cache/
workspace/.cache/
workspace/tmp/
**/__pycache__/
*.pyc
*.pyo
```

## 🐳 Docker 部署

### 快速启动

```bash
# 1. 准备配置文件
cp config.example.yaml config.yaml
# 编辑 config.yaml，填写对应平台凭据和 LLM API Key

# 2. 启动
docker compose up -d

# 3. 查看日志
docker compose logs -f
```

### Telegram Userbot 首次登录

如果使用 Telegram 的 userbot 模式，首次启动需要输入 OTP 验证码：

```bash
docker attach cybergroupmate
# 输入验证码后按 Ctrl+P, Ctrl+Q 脱离（不要 Ctrl+C）
```

### 数据持久化

运行数据（SQLite 数据库、Telegram 会话、事件日志等）存储在 `workspace/` 或 `docker-compose.yaml` 中配置的 Docker volume 中。

```bash
# 备份数据
docker run --rm -v cybergroupmate-data:/data -v $(pwd):/backup alpine tar czf /backup/cybergroupmate-backup.tar.gz -C /data .

# 恢复数据
docker run --rm -v cybergroupmate-data:/data -v $(pwd):/backup alpine tar xzf /backup/cybergroupmate-backup.tar.gz -C /data
```


## 📄 LICENSING

本项目采用 AGPLv3 协议。

对于使用本项目（及其衍生版本）作为 QQ、Telegram、Discord 等平台聊天机器人的行为，任何在群组中与该机器人产生交互的用户，均被视为 AGPLv3 第13条所指的‘通过计算机网络远程交互的用户’。

部署者必须在机器人的回复、状态签名或群组公告中，显著提供获取其修改后源代码的链接。

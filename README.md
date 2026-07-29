# AIRA's Diary

AI 驱动的灵感管理与深度思考工作流系统。

将碎片化的灵感通过 **记录 → 结晶 → 外延 → 提炼 → 繁殖 → 互连** 的工作流逐步深化，借助 LLM 完成感知分类、方向提案、跨灵感桥梁生成与上下文对话，帮助用户把模糊的想法沉淀为结构化的知识。

## 核心功能

- **灵感管理**：记录灵感原文，自动感知类型与标签，支持追加条目（文本/链接/图片）
- **结晶（Crystallize）**：AI 感知灵感类型 → 定制化追问 → 生成结构化结晶体
- **外延（Epitaxy）**：方向提案 → 深挖笔记 → 选词提炼，拓展灵感的可能性边界
- **融合（Coalesce）**：基于语义相似度跨灵感生成桥梁，发现隐藏关联
- **对话探究**：基于灵感上下文与 AI 流式对话，支持联网搜索（SSE 流式输出 + Markdown 渲染）

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18 + Vite + TailwindCSS + Zustand + ReactMarkdown |
| 后端 | Node.js + Express + sql.js (SQLite) |
| AI | OpenAI 兼容协议（默认 DeepSeek V4）+ Transformers.js (本地 embedding) |
| 可视化 | D3.js 力导向图（灵感关联网络） |

## 项目结构

```
AIRA's Diary/
├── backend/                  # 后端服务
│   ├── src/
│   │   ├── agents/           # AI Agent（Crystallize/Epitaxy/Coalesce/Conversation）
│   │   ├── config/           # 模型配置（按 Agent 独立分配模型）
│   │   ├── controllers/      # 请求控制器
│   │   ├── database/         # SQLite 数据库与迁移脚本
│   │   ├── routes/           # Express 路由
│   │   ├── services/         # 业务服务（OpenAI/embedding/搜索/存储）
│   │   └── server.js         # 入口
│   ├── .env.example          # 环境变量模板
│   └── package.json
├── frontend/                 # 前端应用
│   ├── src/
│   │   ├── components/       # React 组件
│   │   ├── services/         # API 调用与状态管理
│   │   └── index.jsx         # 入口
│   └── package.json
└── package.json              # monorepo 根配置（workspaces）
```

## 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9

### 安装

```bash
# 克隆仓库
git clone https://github.com/<your-username>/airas-diary.git
cd airas-diary

# 安装所有 workspace 依赖
npm install
```

### 配置环境变量

```bash
cd backend
cp .env.example .env
```

编辑 `.env`，填入你的 API 密钥：

| 变量 | 说明 | 必填 |
|------|------|------|
| `OPENAI_API_KEY` | OpenAI 兼容服务的 API 密钥 | 是 |
| `OPENAI_BASE_URL` | API 基础地址（默认 OpenAI，可改为 DeepSeek 等） | 否 |
| `OPENAI_DEFAULT_MODEL` | 全局默认模型 | 否 |
| `SERPER_API_KEY` | Serper 搜索密钥（用于联网搜索，留空则不搜索） | 否 |

支持按 Agent 独立配置模型，详见 `.env.example` 中的注释。

### 运行

```bash
# 在项目根目录执行，同时启动前后端
npm run dev

# 或分别启动
npm run dev:backend   # 后端 http://localhost:3001
npm run dev:frontend  # 前端 http://localhost:5173
```

前端默认运行在 `http://localhost:5173`，后端在 `http://localhost:3001`。

### Embedding 模型

后端使用 `Xenova/paraphrase-multilingual-MiniLM-L12-v2`（ONNX 量化版，约 113MB）生成语义向量，用于灵感相似度计算与跨灵感桥梁生成。

- **首次启动时自动下载**：模型不随源码分发，后端启动时会自动从 HuggingFace 下载到 `backend/.cache/hub/`
- **国内网络加速**：默认使用 `https://hf-mirror.com` 镜像，可通过环境变量 `HF_ENDPOINT` 覆盖
- **下载完成后**：后续启动直接从本地缓存加载，无需联网

## License

[MIT](./LICENSE)

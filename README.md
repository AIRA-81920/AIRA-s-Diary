# AIRA's Diary

AI 驱动的灵感管理与深度思考工作流系统。

将碎片化的灵感通过 **记录 → 结晶 → 外延 → 提炼 → 繁殖 → 互连** 的工作流逐步深化，借助 LLM 完成感知分类、方向提案、跨灵感桥梁生成与上下文对话，帮助用户把模糊的想法沉淀为结构化的知识。

---

## 核心功能

### 灵感工作流

| 阶段 | 功能 |
|------|------|
| **灵感管理** | 记录灵感原文，自动感知类型与标签；支持文件夹分组与拖拽排序；删除灵感进入快照（回收站），保留 30 天后自动清理 |
| **结晶（Crystallize）** | AI 感知灵感类型 → 定制化追问 → 生成结构化结晶体（概念卡 / 论证卡 / PRD） |
| **外延（Epitaxy）** | 方向提案 → 深挖笔记 → 选词提炼，拓展灵感的可能性边界 |
| **融合（Coalesce）** | 多源加权语义流水线（标题+正文+指纹三源 embedding 加权 + LLM 精判双分数达标），跨灵感生成桥梁，发现隐藏关联 |
| **对话探究** | 基于灵感上下文与 AI 流式对话，支持联网搜索，保存优秀回答继续思考 |

### 特色能力

- **灵感网络 & 桥梁策展**：D3.js 力导向图总览所有灵感及其关联；新连接以待审虚线呈现，可直接在图上确认 / 忽略
- **AI 头像交互**：长按头像触发弹跳与雨刮式抖动、松手衰减，长按更久可跳转外部链接
- **微光系统**：所有可互动组件的鼠标跟随光斑 + 边框呼应，暗色 / 亮色主题自动适配
- **图片识图**：上传图片自动生成客观描述并异步展示在追加条目下，识图蕴含灵感材料语境，可按需补充关联与延伸
- **灵感文件夹**：像手机桌面一样拖拽灵感合并为文件夹，按主题组织
- **AI 配置面板**：浮动毛玻璃窗口，支持全局 / 按 Agent 独立配置 API Key、模型、Base URL，内置一键检测
- **多源加权相似度**：标题 / 正文 / 语义指纹三源 embedding 加权合成（0.1 / 0.4 / 0.5）+ LLM 精判，双分数达标才建桥
- **追加条目**：灵感创建后可持续添加文本 / 链接 / 图片 / 文件，保持思考时效性
- **暗色 / 亮色主题**：支持 View Transitions 动画切换

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18 + Vite + TailwindCSS + Zustand + ReactMarkdown + D3.js + @dnd-kit |
| 后端 | Node.js + Express + sql.js (SQLite) + Zod |
| AI | OpenAI 兼容协议（支持 GPT / DeepSeek / Claude 等）+ Transformers.js (本地 embedding) |
| 可视化 | D3.js 力导向图（灵感关联网络） |
| 样式 | TailwindCSS + 语义化颜色令牌（dark / light 双主题） |

---

## 项目结构

```
AIRA's Diary/
├── backend/
│   ├── src/
│   │   ├── agents/           # AI Agent（Crystallize / Epitaxy / Coalesce / Conversation / Vision）
│   │   ├── config/           # 模型配置（惰性求值，按 Agent 独立分配）
│   │   ├── controllers/      # 请求控制器
│   │   ├── database/         # SQLite 数据库 & 版本迁移（含快照、多源向量等）
│   │   ├── routes/           # Express 路由
│   │   ├── services/         # 业务服务（embedding / fingerprint / taskQueue / vision / 快照清理等）
│   │   └── server.js
│   ├── .env.example
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/       # React 组件（含头像交互、灵感网络、追加条目等）
│   │   ├── services/         # API 调用 & Zustand store & 前端工具模块（微光、头像逻辑等）
│   │   └── index.jsx
│   └── package.json
├── docs/                     # 产品思考 & 架构文档
├── package.json              # monorepo 根配置
├── Start.bat                 # Windows 一键启动脚本
└── README.md
```

---

## 获取方式

### GitHub Release（推荐，开箱即用）

前往 [Releases](https://github.com/<username>/airas-diary/releases) 下载 `AIRAs-Diary-vX.X.X.7z`。

- **已内置 embedding 模型**（Xenova/paraphrase-multilingual-MiniLM-L12-v2，ONNX 量化版，约 113MB），无需联网下载
- 解压后编辑 `backend/.env.example` 为 `backend/.env`，填入 API Key
- 双击 `Start.bat` 即可启动

### 从源码运行

```bash
git clone https://github.com/<username>/airas-diary.git
cd airas-diary
npm install
cd backend
cp .env.example .env    # 编辑 .env 填入 API Key
cd ..
npm run dev
```

> 源码包不包含 embedding 模型。首次启动时后端会自动从 HuggingFace 下载（国内默认使用 hf-mirror.com 镜像），约 113MB，仅需一次。

---

## 环境配置

编辑 `backend/.env`：

| 变量 | 说明 | 必填 |
|------|------|------|
| `OPENAI_API_KEY` | OpenAI 兼容 API 密钥 | 是 |
| `OPENAI_BASE_URL` | API 基础地址（默认 `https://api.openai.com/v1`） | 否 |
| `OPENAI_DEFAULT_MODEL` | 全局默认模型（如 `deepseek-v4-pro`） | 否 |
| `OPENAI_DEFAULT_TEMPERATURE` | 默认采样温度（0~2） | 否 |
| `SERPER_API_KEY` | Serper 搜索密钥（用于联网搜索，留空禁用） | 否 |

PS：目前只支持SERPER API   qwq

支持按 Agent 独立配置模型（`OPENAI_MODEL_CRYSTALLIZE` 等），详见 `.env.example`。

也可在应用内通过 **设置（齿轮图标）→ API 设置** 面板直接修改，支持一键检测配置是否可用。

---

## 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9

### 启动

```bash
# monorepo 模式（推荐）
npm run dev                # 同时启动前后端

# 或分别启动
npm run dev -w backend    # 后端 http://localhost:3001
npm run dev -w frontend   # 前端 http://localhost:5173
```

也可双击 `Start.bat`（Windows）自动启动，包括帮你打开浏览器。

### 第一个灵感

1. 打开 http://localhost:5173
2. 点击 **新建灵感** → 输入标题与正文 → 保存
3. 点击灵感进入详情 → 选择 **结晶**（Crystallize）→ AI 会感知类型并追问
4. 回答追问 → 生成结晶体 → 可选 **外延**（Epitaxy）深挖
5. 创建第二个灵感 → 点 **找连接** → 发现跨灵感桥梁

---

## 架构亮点

- **任务队列**：指纹生成 / embedding / 增量扫描 / 识图异步执行，不阻塞 API
- **语义指纹**：LLM 将灵感原文+结晶体+词块+维度+胶囊五源蒸馏为 150-200 字结构化摘要，作为向量与 LLM 判别的共享输入
- **多源向量加权**：标题 / 正文 / 指纹三源分别向量化后加权合成（0.1 / 0.4 / 0.5），缺失源权重自动分摊
- **数据版本迁移**：多次向后兼容迁移（胶囊→美学提案→概念卡→追加条目→对话→文件夹→快照→多源向量）
- **快照机制**：删除灵感进入软删除回收站，保留 30 天，后台自动物理清理
- **SSE 流式输出**：对话探究采用 EventSource，Markdown 逐块渲染
- **惰性模型配置**：resolveConfig() 每次调用读取最新 process.env，保存后即时生效
- **微光系统**：全局事件委托实现可互动组件的鼠标跟随光斑，rAF 节流保证性能

---

## 关于这个项目

这个项目最初是我为自己做的。

我有一个持续了很多年的习惯：尽可能的把冒出来的想法记下来，然后反复回头去想它们。有些念头在脑子里待久了，会自己生根发芽；有些需要被追问、被拉伸、被和另一个看似无关的念头放在一起——这时候纸和笔就不够了。

所以我做了 AIRA's Diary。它和 Notion 不一样，和 Obsidian 也不一样。

虽然这些软件我也在用（比如 Mindback，Notion ），但总觉得有点膈应。

那些工具把画布交给你，画什么是你的事。但是AIRA 会推你——它感知你写的是什么类型的东西，问你一些你没想到要问自己的问题，然后帮你把一段模糊的文字变成一个结构化的见解，甚至帮你发现两个看起来毫无关系的灵感之间藏着同一条暗线。

但是说实话，我不知道这个工具能不能帮到别人。

它太定制化了。我拿AI做它的时候满脑子想的是"我自己用着爽不爽"，而不是"别人会不会用"。它的受众肯定不是大多数人——大多数人只是想存起来，然后搜得到，那么大概率会选择 NotebookLM，Notion，obsidian 或者是 Mindback 这样更成熟的应用

但如果你恰好也有这种习惯——记了灵感之后会反复回想，在意念头之间的结构和关系，觉得"被存起来"和"被真正理解"是两件完全不同的事情——那我很想听听你用过之后的感受。

可能是里面的某个功能实际上对你的灵感没有实质性的推进作用，或者说是一些细节方面需要改善，又或者是关于“信息的提炼”———文本过长容易稀释掉想法之类的痛点。

最重点的是——它其实不能说是很聪明，尤其是后面的“聚合”功能，限于实力，它目前对灵感挖掘的深度有限——基于向量和LLM评分（有点难以真正发现连作为记录者的你都没有发现的联系）。并且也没有“找到联系”之后的“融合推广”这种功能。

这个项目大概率不出圈，顶多在我几个朋友之间传来传去。但我确实想在大学阶段把它一直推进下去。

Bug 也好，反直觉的设计也好，"这个功能完全没有存在的必要"也好——什么样的反馈都行。好的让我知道方向没偏，坏的让我知道哪里该改。这两样东西对我来说都是动力。

**产品不只有开发者，还得要有用户。** 而这恰恰是我一个人做不到的。

如果你愿意花时间试用然后告诉我你的想法——[提个 Issue](https://github.com/<username>/airas-diary/issues)，或者发邮箱：2262565619@qq.com，我都会认真看，认真给予回应。

最后，关于命名。其实这个项目和艾拉并没有什么联系（虽然她也有一个日记本，但涵义不一样）。纯粹只是我很喜欢艾拉所以才这样取名的_(:з」∠)_

---

## License

[MIT](./LICENSE)

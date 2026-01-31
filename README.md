# 🌟 InspireFlow - AI灵感管理助手

<div align="center">

一个基于AI的智能灵感收集和管理系统，帮助你自动整理、链接和扩展你的创意想法。

**核心功能**: 自动整理 | 智能链接 | AI启发

</div>

---

## ✨ 核心特性

### 🤖 自动整理
- **智能分类**: AI自动为灵感添加标签
- **内容摘要**: 自动生成简洁的摘要
- **时间轴**: 按时间线组织你的灵感
- **语义搜索**: 基于内容语义的智能搜索

### 🔗 智能链接
- **自动关联**: 基于语义相似度自动建立灵感间的联系
- **双向链接**: 自动维护灵感之间的双向关联
- **相似度评分**: 量化灵感之间的关联程度
- **知识图谱**: 可视化灵感网络(待实现)

### 💡 AI启发
- **启发式提问**: AI生成深度思考问题
- **创意扩展**: 基于现有灵感生成新想法
- **交叉联想**: 融合不同灵感产生创新思路

---

## 🏗️ 技术架构

```
InspireFlow/
├── backend/           # Node.js 后端服务
│   ├── server.js      # Express 主服务器
│   ├── package.json   # 依赖配置
│   └── .env.example   # 环境变量示例
├── frontend/          # React 前端应用
│   ├── src/
│   │   ├── App.js     # 主应用组件
│   │   ├── App.css    # 样式文件
│   │   └── index.js   # 入口文件
│   ├── public/
│   └── package.json
├── scripts/           # Python 脚本
│   ├── embedding_server.py  # 本地向量生成服务
│   └── requirements.txt     # Python 依赖
└── database/          # SQLite 数据库目录
```

### 技术栈

**后端**:
- Node.js + Express
- Sequelize ORM
- SQLite 数据库
- DeepSeek/OpenAI API

**前端**:
- React 18
- 现代 CSS (Grid/Flexbox)
- RESTful API 调用

**AI 服务**:
- Python Flask (本地向量服务)
- Sentence-Transformers (文本嵌入)
- DeepSeek API (对话生成)

---

## 🚀 快速开始

### 前置要求

- Node.js 16+ 
- Python 3.8+
- npm 或 yarn
- DeepSeek API Key (或 OpenAI API Key)

### 1️⃣ 安装后端

```bash
cd backend
npm install
```

### 2️⃣ 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件,填入你的 API Key
```

**.env 配置示例**:
```env
DEEPSEEK_API_KEY=sk-your-deepseek-api-key
AI_BASE_URL=https://api.deepseek.com/v1
AI_MODEL=deepseek-chat
USE_LOCAL_EMBEDDING=true
```

### 3️⃣ 安装前端

```bash
cd ../frontend
npm install
```

### 4️⃣ (可选但推荐) 启动本地向量服务

这是 **0 成本方案**,避免调用付费的 Embedding API:

```bash
cd ../scripts

# 创建虚拟环境
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt

# 启动服务
python embedding_server.py
```

首次运行会自动下载模型(约 120MB),之后秒级启动。

### 5️⃣ 启动应用

**终端 1 - 后端**:
```bash
cd backend
npm start
# 后端运行在 http://localhost:3001
```

**终端 2 - 前端**:
```bash
cd frontend
npm start
# 前端运行在 http://localhost:3000
```

**终端 3 - 向量服务** (如果启用):
```bash
cd scripts
python embedding_server.py
# 向量服务运行在 http://localhost:5000
```

### 6️⃣ 访问应用

打开浏览器访问: **http://localhost:3000**

---

## 📖 使用指南

### 创建灵感

1. 在左侧栏输入你的想法或灵感
2. 点击「创建灵感」按钮
3. AI 会自动:
   - 生成摘要
   - 添加分类标签
   - 生成启发性问题
   - 查找相关灵感并建立链接

### 浏览灵感

- **看板视图**: 卡片式展示所有灵感
- **时间线视图**: 按时间顺序排列
- **标签筛选**: 点击标签查看同类灵感
- **语义搜索**: 输入关键词进行语义搜索

### AI 功能

- **查看启发问题**: 点击灵感卡片查看 AI 生成的思考问题
- **AI 扩展**: 在详情面板点击「AI扩展」生成相关新想法
- **交叉联想**: 点击「交叉联想」按钮,让 AI 融合多个灵感

### 关联网络

- 每个灵感会自动显示相似度最高的关联灵感
- 双向链接确保你可以从任意方向探索想法网络

---

## 🔧 进阶配置

### 集成本地向量服务到后端

修改 `backend/server.js` 中的 `generateEmbedding` 函数:

```javascript
async function generateEmbedding(text) {
  if (process.env.USE_LOCAL_EMBEDDING === 'true') {
    // 使用本地 Python 服务
    const response = await axios.post(
      process.env.LOCAL_EMBEDDING_URL + '/embed',
      { text }
    );
    return response.data.embedding;
  } else {
    // 使用云端 API
    // ... 现有代码
  }
}
```

### 调整相似度阈值

在 `.env` 文件中调整:
```env
SIMILARITY_THRESHOLD=0.3  # 范围: 0-1, 越高越严格
```

### 数据库位置

默认在 `backend/database/inspireflow.db`,可在 `.env` 修改:
```env
DATABASE_PATH=./custom/path/inspireflow.db
```

---

## 📊 API 文档

### 灵感管理

#### 创建灵感
```http
POST /api/inspirations
Content-Type: application/json

{
  "content": "你的灵感内容",
  "source": "manual"
}
```

#### 获取灵感列表
```http
GET /api/inspirations?tag=技术&search=AI&limit=50
```

#### 获取单个灵感
```http
GET /api/inspirations/:id
```

#### 更新灵感
```http
PUT /api/inspirations/:id
Content-Type: application/json

{
  "content": "更新后的内容",
  "tags": ["新标签"]
}
```

#### 删除灵感
```http
DELETE /api/inspirations/:id
```

### AI 功能

#### AI 扩展灵感
```http
POST /api/ai/expand
Content-Type: application/json

{
  "inspirationId": "uuid-here"
}
```

#### 交叉联想
```http
POST /api/ai/cross-inspire
```

### 知识图谱

#### 获取图谱数据
```http
GET /api/graph
```

返回格式:
```json
{
  "nodes": [
    {"id": "uuid", "label": "摘要", "tags": ["tag1"]}
  ],
  "links": [
    {"source": "uuid1", "target": "uuid2", "value": 0.85}
  ]
}
```

---

## 🔮 未来扩展计划

### 短期 (MVP+)
- [ ] 浏览器扩展 (快速收集网页内容)
- [ ] 文件导入 (Markdown, PDF, TXT)
- [ ] 图谱可视化 (D3.js / React-Force-Graph)
- [ ] 导出功能 (JSON, Markdown)

### 中期
- [ ] 语音输入 (语音转文字)
- [ ] 图片 OCR (提取图片中的文字)
- [ ] 多用户支持
- [ ] 协作功能

### 长期
- [ ] 移动端应用 (React Native)
- [ ] 桌面应用 (Electron)
- [ ] 与 Notion、Obsidian 同步
- [ ] 本地 AI 模型集成 (Llama.cpp)
- [ ] 向量数据库集成 (ChromaDB/Pinecone)

---

## 💾 数据持久化升级

当前版本使用 SQLite 存储。当灵感数量超过 1000 条时,建议升级:

### 选项 1: ChromaDB (推荐)

```bash
pip install chromadb
```

优势: 专为向量搜索设计,快速高效

### 选项 2: Pinecone (云服务)

优势: 完全托管,适合大规模应用

---

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request!

### 开发流程

1. Fork 项目
2. 创建功能分支: `git checkout -b feature/AmazingFeature`
3. 提交更改: `git commit -m 'Add some AmazingFeature'`
4. 推送分支: `git push origin feature/AmazingFeature`
5. 提交 Pull Request

---

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

---

## 🙏 致谢

- [OpenAI](https://openai.com/) - GPT 模型
- [DeepSeek](https://www.deepseek.com/) - 高性价比 AI API
- [Sentence-Transformers](https://www.sbert.net/) - 文本嵌入模型
- React 社区和所有开源贡献者

---

## 📞 联系方式

如有问题或建议,欢迎:
- 提交 [GitHub Issue](https://github.com/yourusername/inspireflow/issues)
- 发送邮件到: your.email@example.com

---

<div align="center">

**让 AI 帮你管理灵感,释放创造力!** ✨

Made with ❤️ by InspireFlow Team

</div>

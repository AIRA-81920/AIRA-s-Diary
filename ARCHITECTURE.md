# InspireFlow 技术设计文档

## 1. 系统架构

### 1.1 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                        客户端层                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Web 浏览器   │  │  移动端(未来) │  │  桌面端(未来) │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP/REST
┌────────────────────────┴────────────────────────────────────┐
│                      应用服务层                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │           Node.js Express Server                     │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │   │
│  │  │API路由    │  │业务逻辑   │  │中间件/验证        │  │   │
│  │  └──────────┘  └──────────┘  └──────────────────┘  │   │
│  └──────────────────────────────────────────────────────┘   │
└────────┬───────────────────────┬────────────────────────────┘
         │                       │
         │ Sequelize ORM         │ HTTP/REST
         ▼                       ▼
┌────────────────────┐  ┌────────────────────────────────┐
│   数据存储层        │  │      AI 服务层                  │
│  ┌──────────────┐  │  │  ┌─────────────────────────┐  │
│  │   SQLite     │  │  │  │  Python Flask Server    │  │
│  │  (灵感数据)   │  │  │  │ (Sentence-Transformers) │  │
│  └──────────────┘  │  │  └─────────────────────────┘  │
│                    │  │  ┌─────────────────────────┐  │
│                    │  │  │  DeepSeek/OpenAI API    │  │
│                    │  │  │  (文本生成/对话)         │  │
│                    │  │  └─────────────────────────┘  │
└────────────────────┘  └────────────────────────────────┘
```

### 1.2 核心组件说明

#### 前端 (React)
- **职责**: 用户界面、交互逻辑、状态管理
- **技术**: React 18 + Hooks
- **特点**: 响应式设计、组件化开发

#### 后端 (Node.js + Express)
- **职责**: API 路由、业务逻辑、数据处理
- **核心模块**:
  - 灵感 CRUD
  - AI 服务集成
  - 向量相似度计算
  - 自动链接逻辑

#### 数据层 (SQLite + Sequelize)
- **职责**: 数据持久化、关系管理
- **优势**: 轻量级、零配置、文件存储

#### AI 服务层
- **Python 向量服务**: 本地文本嵌入生成
- **云端 AI API**: 文本生成、摘要、分类

---

## 2. 数据模型

### 2.1 灵感表 (Inspiration)

```javascript
{
  id: UUID,                    // 主键
  content: TEXT,               // 原始内容 (必填)
  summary: TEXT,               // AI 生成的摘要
  tags: JSON,                  // 分类标签数组
  source: STRING,              // 来源: manual/web/voice/file
  vector_embedding: JSON,       // 384维向量数组
  linked_cards: JSON,          // 关联灵感数组
  ai_questions: JSON,          // AI 启发问题数组
  created_at: TIMESTAMP,       // 创建时间
  updated_at: TIMESTAMP        // 更新时间
}
```

#### 字段详解

**content** (TEXT):
- 用户输入的原始灵感内容
- 长度不限,支持富文本(未来)

**summary** (TEXT):
- AI 自动生成的简洁摘要
- 用于快速预览和卡片显示

**tags** (JSON Array):
```json
["技术", "AI", "创新"]
```
- AI 自动分类生成
- 用于筛选和分组

**vector_embedding** (JSON Array):
```json
[0.123, -0.456, 0.789, ...]  // 384个浮点数
```
- 文本的向量表示
- 用于计算语义相似度

**linked_cards** (JSON Array):
```json
[
  {
    "id": "uuid-1",
    "similarity": "0.856",
    "summary": "相关灵感的摘要"
  }
]
```
- 存储关联灵感的引用
- 包含相似度评分

**ai_questions** (JSON Array):
```json
[
  "这个想法可以如何应用到教育领域?",
  "如果资源无限,你会如何扩展这个概念?",
  "这个想法的本质假设是什么?"
]
```
- AI 生成的启发性问题
- 用于深度思考引导

---

## 3. 核心算法

### 3.1 文本嵌入 (Text Embedding)

#### 方案 A: 本地生成 (推荐)

使用 Sentence-Transformers:

```python
from sentence_transformers import SentenceTransformer

model = SentenceTransformer('paraphrase-multilingual-MiniLM-L12-v2')
embedding = model.encode(text)  # 输出: 384维向量
```

**优势**:
- 完全免费
- 响应快速 (秒级)
- 隐私安全

#### 方案 B: 云端 API

```javascript
// 使用 OpenAI Embeddings API
const response = await openai.embeddings.create({
  model: "text-embedding-3-small",
  input: text
});
```

**优势**:
- 无需本地部署
- 模型质量高

### 3.2 余弦相似度计算

```javascript
function cosineSimilarity(vecA, vecB) {
  // 点积
  const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  
  // 向量模长
  const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  
  // 余弦值
  return dotProduct / (magnitudeA * magnitudeB);
}
```

**相似度解读**:
- 1.0: 完全相同
- 0.7-0.9: 高度相关
- 0.5-0.7: 中度相关
- 0.3-0.5: 弱相关
- < 0.3: 不相关

### 3.3 自动链接算法

```javascript
async function autoLink(newInspiration) {
  const threshold = 0.3;  // 相似度阈值
  const allInspirations = await Inspiration.findAll();
  
  const links = [];
  
  for (const existing of allInspirations) {
    if (existing.id === newInspiration.id) continue;
    
    const similarity = cosineSimilarity(
      newInspiration.vector_embedding,
      existing.vector_embedding
    );
    
    if (similarity > threshold) {
      // 双向链接
      links.push({
        id: existing.id,
        similarity: similarity.toFixed(3),
        summary: existing.summary
      });
      
      // 更新对方的链接
      await existing.addLink(newInspiration);
    }
  }
  
  // 按相似度排序
  links.sort((a, b) => b.similarity - a.similarity);
  
  return links.slice(0, 10);  // 最多保留10个链接
}
```

---

## 4. AI 服务集成

### 4.1 文本生成流程

```javascript
async function generateAIResponse(prompt, systemPrompt) {
  const response = await axios.post(
    `${AI_BASE_URL}/chat/completions`,
    {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 1000
    },
    {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  return response.data.choices[0].message.content;
}
```

### 4.2 提示词工程

#### 自动分类
```
系统提示: 你是一个内容分类专家

用户提示:
请为以下内容生成3-5个简洁的分类标签(中文)。
内容: {content}
要求:
1. 标签要准确反映内容主题
2. 使用常见分类如: 技术、设计、商业、学习、创意、生活等
3. 只返回标签,用逗号分隔,不要其他解释
标签:
```

#### 生成摘要
```
系统提示: 你是一个精炼的摘要助手

用户提示:
请用一句话概括以下内容的核心思想(50字以内):
{content}
摘要:
```

#### 启发性提问
```
系统提示: 你是一个创意思维教练

用户提示:
基于以下灵感内容,生成3个启发性问题来帮助深入思考:
内容: {content}
要求:
1. 问题要有启发性和延展性
2. 鼓励跨领域思考
3. 每个问题一行,不要编号
问题:
```

---

## 5. 性能优化

### 5.1 数据库优化

#### 索引策略
```sql
-- 为常用查询字段创建索引
CREATE INDEX idx_created_at ON Inspirations(created_at);
CREATE INDEX idx_tags ON Inspirations(tags);  -- JSON 字段索引
```

#### 查询优化
```javascript
// 分页查询
const inspirations = await Inspiration.findAll({
  limit: 50,
  offset: page * 50,
  order: [['created_at', 'DESC']]
});

// 只选择必要字段
const summaries = await Inspiration.findAll({
  attributes: ['id', 'summary', 'tags']
});
```

### 5.2 向量搜索优化

当灵感数量 > 1000 时,考虑:

#### 选项 1: 近似最近邻 (ANN)
```javascript
// 使用 Annoy 或 HNSW 算法
const annoy = new AnnoyIndex(384, 'angular');
annoy.addItem(id, vector);
annoy.build(10);

const nearestIds = annoy.getNNsByVector(queryVector, 10);
```

#### 选项 2: 向量数据库
- **ChromaDB**: 开源,适合中小规模
- **Pinecone**: 云服务,适合大规模
- **Weaviate**: 开源,功能丰富

### 5.3 缓存策略

```javascript
const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 600 });

// 缓存常用数据
app.get('/api/tags', (req, res) => {
  const cached = cache.get('all_tags');
  if (cached) return res.json(cached);
  
  const tags = getAllTags();
  cache.set('all_tags', tags);
  res.json(tags);
});
```

---

## 6. 安全性考虑

### 6.1 API 密钥管理

```javascript
// 使用环境变量
require('dotenv').config();
const API_KEY = process.env.DEEPSEEK_API_KEY;

// 永远不要硬编码在代码中!
```

### 6.2 输入验证

```javascript
// 验证用户输入
function validateInspiration(content) {
  if (!content || typeof content !== 'string') {
    throw new Error('内容必须是非空字符串');
  }
  
  if (content.length > 10000) {
    throw new Error('内容过长');
  }
  
  // 防止 SQL 注入 (Sequelize 自动处理)
  // 防止 XSS (前端需处理)
  
  return content.trim();
}
```

### 6.3 速率限制

```javascript
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15分钟
  max: 100  // 限制100个请求
});

app.use('/api/', limiter);
```

---

## 7. 部署方案

### 7.1 开发环境

```bash
# 本地运行
npm run dev  # 后端
npm start    # 前端
python embedding_server.py  # 向量服务
```

### 7.2 生产环境

#### Docker 部署 (推荐)

```dockerfile
# Dockerfile
FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3001
CMD ["node", "server.js"]
```

```yaml
# docker-compose.yml
version: '3.8'
services:
  backend:
    build: ./backend
    ports:
      - "3001:3001"
    environment:
      - DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}
    volumes:
      - ./database:/app/database
  
  frontend:
    build: ./frontend
    ports:
      - "3000:3000"
    depends_on:
      - backend
  
  embedding:
    build: ./scripts
    ports:
      - "5000:5000"
```

#### 云部署选项

1. **Vercel** (前端):
   - 零配置部署
   - 全球 CDN
   - 自动 HTTPS

2. **Railway/Render** (后端):
   - 简单部署
   - 自动扩展
   - 内置数据库

3. **AWS/阿里云** (完整部署):
   - EC2/ECS 实例
   - RDS 数据库
   - S3/OSS 存储

---

## 8. 监控与日志

### 8.1 日志记录

```javascript
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// 使用
logger.info('灵感创建', { id: inspiration.id });
logger.error('AI服务失败', { error: err.message });
```

### 8.2 性能监控

```javascript
// API 响应时间监控
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('API调用', {
      method: req.method,
      url: req.url,
      duration
    });
  });
  next();
});
```

---

## 9. 测试策略

### 9.1 单元测试

```javascript
// tests/similarity.test.js
const { cosineSimilarity } = require('../utils');

test('相同向量相似度为1', () => {
  const vec = [1, 2, 3];
  expect(cosineSimilarity(vec, vec)).toBe(1);
});

test('正交向量相似度为0', () => {
  const vec1 = [1, 0, 0];
  const vec2 = [0, 1, 0];
  expect(cosineSimilarity(vec1, vec2)).toBe(0);
});
```

### 9.2 集成测试

```javascript
// tests/api.test.js
const request = require('supertest');
const app = require('../server');

test('创建灵感', async () => {
  const response = await request(app)
    .post('/api/inspirations')
    .send({ content: '测试灵感' })
    .expect(200);
  
  expect(response.body.success).toBe(true);
  expect(response.body.data.summary).toBeDefined();
});
```

---

## 10. 未来架构演进

### 10.1 微服务化

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│   API网关    │──▶│  灵感服务    │   │   AI服务    │
└─────────────┘   └─────────────┘   └─────────────┘
                         │                  │
                         ▼                  ▼
                  ┌─────────────┐   ┌─────────────┐
                  │   数据库     │   │  向量库      │
                  └─────────────┘   └─────────────┘
```

### 10.2 事件驱动架构

```javascript
// 使用消息队列 (RabbitMQ/Redis)
eventEmitter.on('inspiration.created', async (inspiration) => {
  await generateEmbedding(inspiration);
  await autoClassify(inspiration);
  await autoLink(inspiration);
  await generateQuestions(inspiration);
});
```

### 10.3 边缘计算

将向量计算分布到边缘节点,降低延迟。

---

## 附录: 参考资源

- **Sentence-Transformers**: https://www.sbert.net/
- **DeepSeek API**: https://platform.deepseek.com/
- **Sequelize 文档**: https://sequelize.org/
- **React 最佳实践**: https://react.dev/

---

**文档版本**: v1.0  
**最后更新**: 2025-01-31

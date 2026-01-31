# 🚀 InspireFlow 快速上手指南

## 5分钟快速体验

### 方法1: 使用一键启动脚本 (推荐)

```bash
# 克隆/解压项目后
cd inspireflow
./start.sh
```

脚本会自动:
- ✅ 检查依赖
- ✅ 安装 npm 包
- ✅ 创建 .env 文件
- ✅ 启动所有服务

### 方法2: 手动启动

#### 步骤1: 安装依赖

```bash
# 后端
cd backend
npm install

# 前端
cd ../frontend
npm install

# Python向量服务(可选)
cd ../scripts
python3 -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

#### 步骤2: 配置环境

```bash
cd backend
cp .env.example .env
# 编辑 .env 文件,填入你的 API Key
```

最小配置:
```env
DEEPSEEK_API_KEY=sk-your-key-here
```

#### 步骤3: 启动服务

**终端1 - 后端**:
```bash
cd backend
npm start
```

**终端2 - 前端**:
```bash
cd frontend
npm start
```

**终端3 - 向量服务(可选)**:
```bash
cd scripts
source venv/bin/activate
python embedding_server.py
```

#### 步骤4: 访问应用

打开浏览器: **http://localhost:3000**

---

## 第一次使用

### 1. 创建第一个灵感

在左侧输入框输入:
```
使用AI自动整理笔记可以大大提高学习效率
```

点击「创建灵感」,等待2-3秒。

### 2. 查看AI处理结果

系统会自动:
- ✨ 生成摘要
- 🏷️ 添加标签 (如: 技术、AI、学习)
- 💭 生成3个启发性问题
- 🔗 查找相关灵感(如果有的话)

### 3. 创建第二个灵感

```
费曼学习法:通过教授他人来深化理解
```

系统会自动发现这两个灵感的相似性并建立链接!

### 4. 尝试AI功能

- 点击灵感卡片查看详情
- 点击「AI扩展」按钮生成新想法
- 点击「交叉联想」融合不同灵感

---

## 常见问题

### Q: 提示"AI服务调用失败"?

**原因**: API Key 未配置或无效

**解决**:
1. 检查 `backend/.env` 文件
2. 确认 `DEEPSEEK_API_KEY` 已正确填写
3. 重启后端服务

### Q: 向量服务无法启动?

**原因**: Python 依赖未安装

**解决**:
```bash
cd scripts
pip install -r requirements.txt
```

如果仍然失败,可以不启动向量服务,系统会使用降级方案。

### Q: 前端显示"无法连接到后端"?

**原因**: 后端未启动或端口被占用

**解决**:
1. 检查后端是否在运行
2. 确认端口3001未被占用
3. 检查防火墙设置

### Q: 创建灵感很慢?

**原因**: AI API 响应慢

**优化**:
1. 启用本地向量服务 (0成本,更快)
2. 调整 API 超时设置
3. 使用国内API镜像

---

## 进阶功能

### 批量导入灵感

```bash
# 准备一个 JSON 文件: inspirations.json
[
  {"content": "灵感1"},
  {"content": "灵感2"}
]

# 使用脚本导入
node backend/import.js inspirations.json
```

### 导出所有数据

```bash
# 导出为 JSON
curl http://localhost:3001/api/inspirations > backup.json

# 或使用前端的导出功能(开发中)
```

### 自定义标签分类

修改 `backend/server.js` 中的 `autoClassify` 函数:

```javascript
const keywords = {
  '技术': ['代码', '编程', 'AI'],
  '设计': ['UI', 'UX', '美学'],
  '你的分类': ['关键词1', '关键词2']
};
```

---

## 性能优化建议

### 1. 启用本地向量服务

在 `.env` 中设置:
```env
USE_LOCAL_EMBEDDING=true
LOCAL_EMBEDDING_URL=http://localhost:5000
```

**效果**: 
- ⚡ 速度提升 10倍
- 💰 成本降为 0
- 🔒 数据更安全

### 2. 调整相似度阈值

```env
SIMILARITY_THRESHOLD=0.3  # 降低以显示更多关联
```

### 3. 限制查询数量

```env
MAX_INSPIRATIONS=100  # 每页最多显示条数
```

---

## 下一步

- 📚 阅读 [完整文档](README.md)
- 🏗️ 了解 [技术架构](ARCHITECTURE.md)
- 🌟 探索更多功能
- 💬 反馈问题和建议

---

## 技术支持

遇到问题?
1. 查看 [常见问题](#常见问题)
2. 提交 [GitHub Issue](https://github.com/yourusername/inspireflow/issues)
3. 查看日志: `backend/logs/combined.log`

---

**现在开始,让AI帮你管理灵感吧!** ✨

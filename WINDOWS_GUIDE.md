# 🪟 Windows 用户专用启动指南

## 方法一: 使用批处理脚本 (最简单 ⭐推荐)

### 步骤 1: 解压项目
将 `inspireflow-complete.tar.gz` 解压到任意位置，比如:
```
C:\Users\你的用户名\Downloads\inspireflow
```

### 步骤 2: 双击运行
直接**双击** `start.bat` 文件

脚本会自动:
- ✅ 检查 Node.js 是否安装
- ✅ 安装所有依赖包
- ✅ 创建 .env 配置文件
- ✅ 启动后端和前端服务

### 步骤 3: 配置 API Key (首次运行)
首次运行时，脚本会:
1. 自动打开记事本，显示 `.env` 文件
2. 找到这一行: `DEEPSEEK_API_KEY=your_deepseek_api_key_here`
3. 替换为你的真实 API Key: `DEEPSEEK_API_KEY=sk-xxxxxx`
4. 保存文件 (Ctrl+S)
5. 关闭记事本
6. 再次双击 `start.bat`

### 步骤 4: 等待启动
会弹出 2 个命令窗口:
- 🔧 **后端窗口** (黑色) - 不要关闭
- 🎨 **前端窗口** (黑色) - 不要关闭

几秒钟后，浏览器会自动打开: **http://localhost:3000**

---

## 方法二: 启用本地向量服务 (可选，0成本)

如果你已经安装了 Python:

1. **双击** `start-embedding.bat`
2. 等待模型下载 (首次约120MB，之后秒开)
3. 看到 "运行在 http://localhost:5000" 即成功
4. 保持这个窗口打开

然后在 `backend\.env` 文件中添加:
```
USE_LOCAL_EMBEDDING=true
LOCAL_EMBEDDING_URL=http://localhost:5000
```

这样就完全不需要调用付费的 Embedding API 了！

---

## 常见问题解决

### ❌ 问题 1: "Node.js 未安装"

**解决方法:**
1. 访问: https://nodejs.org/
2. 下载 LTS 版本 (推荐)
3. 安装后重启电脑
4. 重新运行 `start.bat`

### ❌ 问题 2: "端口被占用"

**症状:** 后端窗口显示 "Error: listen EADDRINUSE :::3001"

**解决方法:**
```bash
# 打开 PowerShell (管理员模式)
# 查找占用端口的进程
netstat -ano | findstr :3001

# 结束该进程 (替换 PID 为实际进程号)
taskkill /PID 进程号 /F

# 重新运行 start.bat
```

### ❌ 问题 3: "npm install 失败"

**解决方法:**
```bash
# 清理 npm 缓存
npm cache clean --force

# 删除 node_modules 文件夹
# 然后重新运行 start.bat
```

### ❌ 问题 4: 浏览器没有自动打开

**解决方法:**
手动打开浏览器，访问: http://localhost:3000

### ❌ 问题 5: "AI服务调用失败"

**原因:** API Key 未配置或无效

**解决方法:**
1. 打开 `backend\.env` 文件
2. 检查 `DEEPSEEK_API_KEY=` 后面是否是有效的密钥
3. 保存后，关闭两个命令窗口
4. 重新双击 `start.bat`

---

## 停止服务

### 方法 1: 关闭窗口
直接关闭打开的命令窗口即可

### 方法 2: 使用快捷键
在命令窗口中按 `Ctrl + C`，然后输入 `Y` 确认

---

## 文件说明

```
inspireflow/
├── start.bat                    ← 主启动脚本 (双击这个)
├── start-embedding.bat          ← 向量服务脚本 (可选)
├── start.sh                     ← Linux/Mac 脚本 (Windows不用管)
└── ...其他文件
```

---

## 获取 DeepSeek API Key

1. 访问: https://platform.deepseek.com/
2. 注册/登录账号
3. 进入 "API Keys" 页面
4. 点击 "Create API Key"
5. 复制生成的密钥 (格式: sk-xxxxxx)
6. 粘贴到 `backend\.env` 文件中

**费用说明:**
- DeepSeek 性价比很高
- 新用户通常有免费额度
- 本项目日常使用成本很低 (< ¥1/天)

---

## 下一步

启动成功后:
1. 📝 在左侧输入框写下你的第一个灵感
2. 🤖 等待 AI 自动处理 (2-3秒)
3. 👀 查看自动生成的标签、摘要和启发问题
4. 🔗 创建更多灵感，体验自动关联功能

---

## 需要帮助?

- 📖 查看 `QUICKSTART.md` 了解更多
- 📚 查看 `README.md` 了解完整功能
- 🏗️ 查看 `ARCHITECTURE.md` 了解技术细节

---

**现在就开始使用 InspireFlow 吧!** ✨

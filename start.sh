#!/bin/bash

# InspireFlow 一键启动脚本
# 自动检查依赖、安装包、启动服务

set -e

echo "╔════════════════════════════════════════════════════════╗"
echo "║          InspireFlow 启动脚本                           ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检查 Node.js
echo "📦 检查依赖..."
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js 未安装${NC}"
    echo "请访问 https://nodejs.org/ 安装 Node.js"
    exit 1
fi
echo -e "${GREEN}✓ Node.js 版本: $(node --version)${NC}"

# 检查 Python (可选)
if command -v python3 &> /dev/null; then
    echo -e "${GREEN}✓ Python 版本: $(python3 --version)${NC}"
    PYTHON_AVAILABLE=true
else
    echo -e "${YELLOW}⚠ Python 未安装 (向量服务将不可用)${NC}"
    PYTHON_AVAILABLE=false
fi

echo ""

# 安装后端依赖
echo "🔧 安装后端依赖..."
cd backend
if [ ! -d "node_modules" ]; then
    npm install
    echo -e "${GREEN}✓ 后端依赖安装完成${NC}"
else
    echo -e "${GREEN}✓ 后端依赖已存在${NC}"
fi

# 检查环境变量
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}⚠ .env 文件不存在${NC}"
    echo "正在创建 .env 文件..."
    cp .env.example .env
    echo -e "${YELLOW}⚠ 请编辑 backend/.env 文件,填入你的 API Key${NC}"
    echo "   DEEPSEEK_API_KEY=你的密钥"
    echo ""
    read -p "按回车继续 (或 Ctrl+C 退出)..."
fi

cd ..

# 安装前端依赖
echo ""
echo "🎨 安装前端依赖..."
cd frontend
if [ ! -d "node_modules" ]; then
    npm install
    echo -e "${GREEN}✓ 前端依赖安装完成${NC}"
else
    echo -e "${GREEN}✓ 前端依赖已存在${NC}"
fi
cd ..

# 安装 Python 依赖 (可选)
if [ "$PYTHON_AVAILABLE" = true ]; then
    echo ""
    read -p "是否启动本地向量服务? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        cd scripts
        
        # 检查虚拟环境
        if [ ! -d "venv" ]; then
            echo "创建 Python 虚拟环境..."
            python3 -m venv venv
        fi
        
        # 激活虚拟环境并安装依赖
        source venv/bin/activate
        echo "安装 Python 依赖..."
        pip install -q -r requirements.txt
        echo -e "${GREEN}✓ Python 依赖安装完成${NC}"
        
        # 启动向量服务
        echo ""
        echo "🚀 启动向量服务..."
        python embedding_server.py &
        EMBEDDING_PID=$!
        echo -e "${GREEN}✓ 向量服务已启动 (PID: $EMBEDDING_PID)${NC}"
        
        cd ..
    fi
fi

# 启动后端
echo ""
echo "🚀 启动后端服务..."
cd backend
npm start &
BACKEND_PID=$!
echo -e "${GREEN}✓ 后端服务已启动 (PID: $BACKEND_PID)${NC}"
cd ..

# 等待后端启动
sleep 3

# 启动前端
echo ""
echo "🎨 启动前端应用..."
cd frontend
npm start &
FRONTEND_PID=$!
echo -e "${GREEN}✓ 前端应用已启动 (PID: $FRONTEND_PID)${NC}"
cd ..

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║              InspireFlow 启动成功!                      ║"
echo "╠════════════════════════════════════════════════════════╣"
echo "║  📱 前端:  http://localhost:3000                       ║"
echo "║  🔧 后端:  http://localhost:3001                       ║"
if [ "$PYTHON_AVAILABLE" = true ] && [[ $REPLY =~ ^[Yy]$ ]]; then
echo "║  🤖 向量:  http://localhost:5000                       ║"
fi
echo "╠════════════════════════════════════════════════════════╣"
echo "║  按 Ctrl+C 停止所有服务                                 ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# 捕获退出信号,清理进程
cleanup() {
    echo ""
    echo "正在停止服务..."
    kill $BACKEND_PID 2>/dev/null || true
    kill $FRONTEND_PID 2>/dev/null || true
    if [ ! -z "$EMBEDDING_PID" ]; then
        kill $EMBEDDING_PID 2>/dev/null || true
    fi
    echo "所有服务已停止"
    exit 0
}

trap cleanup SIGINT SIGTERM

# 等待用户中断
wait

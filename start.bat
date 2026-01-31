@echo off
echo ========================================================
echo          InspireFlow Startup Script (Windows)
echo ========================================================
echo.

REM Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found
    echo Please install from: https://nodejs.org/
    pause
    exit /b 1
)
echo [OK] Node.js installed:
node --version
echo.

REM Install backend dependencies
echo [1/4] Installing backend dependencies...
cd backend
if not exist node_modules (
    echo Installing...
    call npm install
    echo [OK] Backend dependencies installed
) else (
    echo [OK] Backend dependencies exist
)

REM Check .env file
if not exist .env (
    echo.
    echo [WARNING] .env file not found
    copy .env.example .env >nul
    echo [OK] Created .env file
    echo.
    echo ========================================================
    echo  IMPORTANT: Configure API Key
    echo ========================================================
    echo  1. Open: backend\.env with Notepad
    echo  2. Find: DEEPSEEK_API_KEY=your_deepseek_api_key_here
    echo  3. Replace with your real API Key
    echo  4. Save and run this script again
    echo ========================================================
    echo.
    start notepad .env
    pause
    exit /b 0
)

cd ..

REM Install frontend dependencies
echo.
echo [2/4] Installing frontend dependencies...
cd frontend
if not exist node_modules (
    echo Installing...
    call npm install
    echo [OK] Frontend dependencies installed
) else (
    echo [OK] Frontend dependencies exist
)
cd ..

echo.
echo [3/4] Starting backend server...
start "InspireFlow Backend" cmd /k "cd backend && npm start"
timeout /t 3 >nul

echo.
echo [4/4] Starting frontend app...
start "InspireFlow Frontend" cmd /k "cd frontend && npm start"

echo.
echo ========================================================
echo              InspireFlow Started Successfully!
echo ========================================================
echo  Frontend: http://localhost:3000
echo  Backend:  http://localhost:3001
echo ========================================================
echo  Two command windows will stay open
echo  Close them to stop the services
echo ========================================================
echo.
echo Press any key to close this window...
pause >nul

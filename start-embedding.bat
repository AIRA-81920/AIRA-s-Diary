@echo off
echo ========================================================
echo       InspireFlow Local Embedding Service (Optional)
echo ========================================================
echo.

REM Check Python
where python >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Python not found
    echo Please install from: https://www.python.org/
    pause
    exit /b 1
)
echo [OK] Python installed:
python --version
echo.

cd scripts

REM Create virtual environment
if not exist venv (
    echo [1/3] Creating Python virtual environment...
    python -m venv venv
    echo [OK] Virtual environment created
)

REM Activate and install dependencies
echo.
echo [2/3] Installing Python dependencies...
echo (First run will download model, about 120MB)
call venv\Scripts\activate.bat
pip install -q -r requirements.txt
echo [OK] Dependencies installed

REM Start service
echo.
echo [3/3] Starting embedding service...
echo ========================================================
echo  Service running at: http://localhost:5000
echo  Keep this window open
echo  Close it to stop the service
echo ========================================================
echo.
python embedding_server.py

pause

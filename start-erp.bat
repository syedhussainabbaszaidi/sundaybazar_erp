@echo off
REM SundayBazar ERP on this PC: web server + background minute clock (Shopify sync, webhook retries, jobs).
REM Close both windows to stop. The ERP opens at http://127.0.0.1:8000/login
cd /d "%~dp0"
start "SundayBazar ERP - web" cmd /k php artisan serve --host=127.0.0.1 --port=8000
start "SundayBazar ERP - background sync" cmd /k php artisan schedule:work
timeout /t 3 >nul
start "" http://127.0.0.1:8000/login

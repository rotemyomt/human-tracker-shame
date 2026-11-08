@echo off
rem Serves the dashboard at http://localhost:8000 (Web Serial needs localhost or HTTPS).
cd /d "%~dp0web"
echo Open http://localhost:8000 in Chrome or Edge. Press Ctrl+C to stop.
where py >nul 2>nul && (py -m http.server 8000 --bind 127.0.0.1 & goto :eof)
where python >nul 2>nul && (python -m http.server 8000 --bind 127.0.0.1 & goto :eof)
where npx >nul 2>nul && (npx --yes serve -l 8000 . & goto :eof)
echo Install Python 3 (https://www.python.org) or Node.js first.
pause

# Запуск JustAI одной командой: Ollama, сервер, интерфейс и браузер.
# Настройки берутся как есть: server/.env, .justai/settings.json, выбранная папка проекта.
# Остановить: закрыть окна «JustAI — сервер» и «JustAI — интерфейс» (Ollama можно оставить).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Step($text) { Write-Host "`n» $text" -ForegroundColor Cyan }
function Test-Url($url) {
    try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}
function Wait-Url($url, $seconds, $name) {
    for ($i = 0; $i -lt $seconds; $i++) {
        if (Test-Url $url) { Write-Host "  $name готов" -ForegroundColor Green; return $true }
        Start-Sleep 1
    }
    Write-Host "  $name не ответил за $seconds с — посмотрите его окно" -ForegroundColor Yellow
    return $false
}

$Host.UI.RawUI.WindowTitle = "JustAI — запуск"
Write-Host "JustAI: запуск из $root" -ForegroundColor White

# 1. Node.js и зависимости
Write-Step "Проверка Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "  Node.js не найден. Установите Node.js 22+ с https://nodejs.org и запустите снова." -ForegroundColor Red
    Read-Host "Enter — выход"; exit 1
}
Write-Host "  node $(node --version)"

if (-not (Test-Path (Join-Path $root "node_modules"))) {
    Write-Step "Первый запуск: npm install (несколько минут)"
    npm install
    if ($LASTEXITCODE -ne 0) { Write-Host "  npm install завершился с ошибкой" -ForegroundColor Red; Read-Host "Enter — выход"; exit 1 }
}

# 2. Ollama (локальные модели: исполнитель, последний резерв, поиск по коду, подсказки)
Write-Step "Ollama"
if (Test-Url "http://127.0.0.1:11434/api/tags") {
    Write-Host "  уже запущена" -ForegroundColor Green
}
elseif (Get-Command ollama -ErrorAction SilentlyContinue) {
    # Зависший llama-server от прошлого запуска держит видеопамять — завершаем.
    Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    # Параметры для 8 ГБ видеопамяти (см. AGENTS.md). Окно 9216 — максимум, при котором qwen3.5:9b целиком
    # на видеокарте (100% GPU: ~45 ток/с против ~33 при 16K с частью на процессоре). Модель держится в памяти 30 мин,
    # одна модель и один запрос за раз — видеопамять не делится. Прокси Ollama не нужен: он ломает загрузку моделей.
    $env:OLLAMA_CONTEXT_LENGTH = "9216"
    $env:OLLAMA_FLASH_ATTENTION = "1"
    $env:OLLAMA_KV_CACHE_TYPE = "q8_0"
    $env:OLLAMA_KEEP_ALIVE = "30m"
    $env:OLLAMA_MAX_LOADED_MODELS = "1"
    $env:OLLAMA_NUM_PARALLEL = "1"
    Remove-Item Env:HTTPS_PROXY, Env:HTTP_PROXY, Env:ALL_PROXY -ErrorAction SilentlyContinue

    Start-Process ollama -ArgumentList "serve" -WindowStyle Minimized
    Wait-Url "http://127.0.0.1:11434/api/tags" 30 "Ollama" | Out-Null
}
else {
    Write-Host "  Ollama не установлена — работают только облачные провайдеры (https://ollama.com)" -ForegroundColor Yellow
}

# 3. Сервер JustAI
Write-Step "Сервер JustAI (http://127.0.0.1:4302)"
if (Test-Url "http://127.0.0.1:4302/api/health") {
    Write-Host "  уже запущен" -ForegroundColor Green
}
else {
    Start-Process powershell -ArgumentList "-NoExit", "-NoProfile", "-Command", "`$Host.UI.RawUI.WindowTitle = 'JustAI — сервер'; Set-Location -LiteralPath '$root'; npm run dev:server"
    Wait-Url "http://127.0.0.1:4302/api/health" 120 "Сервер" | Out-Null
}

# 4. Интерфейс
Write-Step "Интерфейс (http://localhost:3000)"
if (Test-Url "http://localhost:3000") {
    Write-Host "  уже запущен" -ForegroundColor Green
}
else {
    Start-Process powershell -ArgumentList "-NoExit", "-NoProfile", "-Command", "`$Host.UI.RawUI.WindowTitle = 'JustAI — интерфейс'; Set-Location -LiteralPath '$root'; npm run dev:web"
    Wait-Url "http://localhost:3000" 120 "Интерфейс" | Out-Null
}

# 5. Браузер
Write-Step "Открываю http://localhost:3000"
$url = "http://localhost:3000"
$opened = $false

# Браузер по умолчанию; если он не задан в Windows — Edge или Chrome напрямую.
try { Start-Process $url; $opened = $true } catch {}

if (-not $opened) {
    foreach ($browser in @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )) {
        if (Test-Path $browser) {
            try { Start-Process $browser -ArgumentList $url; $opened = $true; break } catch {}
        }
    }
}

if (-not $opened) {
    Write-Host "  Браузер не найден — откройте вручную: $url" -ForegroundColor Yellow
}

Write-Host "`nJustAI запущен. Остановить — закрыть окна «JustAI — сервер» и «JustAI — интерфейс»." -ForegroundColor Green
Start-Sleep 5

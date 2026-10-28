# Inicia o GTD e, se configurado, o túnel da Cloudflare — sem janelas. Seguro rodar mais de uma vez.
# Usado na inicialização do Windows (atalho na pasta Inicializar). Logs em data/logs/.
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

$port = if ($env:PORT) { $env:PORT } else { '4317' }
$up = $false
try { $up = (Invoke-WebRequest "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch {}
if (-not $up) {
  Start-Process -FilePath 'node' -ArgumentList '--disable-warning=ExperimentalWarning', 'server/index.mjs' -WorkingDirectory $root `
    -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'gtd.log') -RedirectStandardError (Join-Path $logs 'gtd-erros.log')
}

$cf = @("$env:ProgramFiles\cloudflared\cloudflared.exe", "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$cfg = Join-Path $env:USERPROFILE '.cloudflared\config.yml'
if ($cf -and (Test-Path $cfg) -and -not (Get-Process cloudflared -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $cf -ArgumentList 'tunnel', '--logfile', (Join-Path $logs 'tunel.log'), 'run' -WindowStyle Hidden
}

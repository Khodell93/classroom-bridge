# Builds ClassroomBridge.exe on this Windows PC and swaps it into the installed copy.
# For when GitHub's build service isn't available. Only the companion program is rebuilt; the AirPlay receiver
# that the MSI installed is kept as it is.
#
# Run from an Administrator PowerShell, in the folder that contains this script:
#   powershell -ExecutionPolicy Bypass -File .\build_on_windows.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }

Step "Checking for Python 3.11"
$python = $null
try { & py -3.11 -c "import sys" 2>$null; if ($LASTEXITCODE -eq 0) { $python = "py" } } catch {}
if (-not $python) {
    Write-Host "Python 3.11 not found: downloading the official installer from python.org (this user only)..."
    $installer = Join-Path $env:TEMP "python-3.11.9-amd64.exe"
    Invoke-WebRequest "https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe" -OutFile $installer
    Start-Process $installer -ArgumentList "/quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 Include_test=0" -Wait
    $env:PATH = "$env:LOCALAPPDATA\Programs\Python\Python311;$env:LOCALAPPDATA\Programs\Python\Python311\Scripts;$env:LOCALAPPDATA\Programs\Python\Launcher;$env:PATH"
    $python = "py"
}
& py -3.11 --version

Step "Installing what the build needs (a few minutes the first time)"
& py -3.11 -m pip install --disable-pip-version-check -q -r requirements.txt pyinstaller
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

Step "Stamping the build time"
# Without this the updater would think this copy is old and replace it with the last published version.
[DateTimeOffset]::UtcNow.ToUnixTimeSeconds() | Out-File -Encoding ascii version.txt

Step "Building ClassroomBridge.exe (a few minutes)"
& py -3.11 -m PyInstaller --noconfirm --clean --onefile --windowed --name ClassroomBridge --icon assets/app.ico `
    --add-data "assets:assets" --add-data "version.txt:." --hidden-import pystray._win32 `
    --collect-all winrt --hidden-import airplay_beacon --collect-submodules qrcode `
    --collect-all aiortc --collect-all av --collect-all aioice --collect-all pylibsrtp `
    --collect-all websockets --collect-data certifi --hidden-import companion_ui --hidden-import update_service main.py
if ($LASTEXITCODE -ne 0 -or -not (Test-Path dist\ClassroomBridge.exe)) { throw "The build failed - send a screenshot of the messages above." }

Step "Installing it"
$target = "C:\Program Files\Classroom Bridge\ClassroomBridge.exe"
if (-not (Test-Path $target)) { throw "Couldn't find $target. The new program is in $PSScriptRoot\dist - copy it next to your airplay folder yourself." }
Get-Process ClassroomBridge -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2
Copy-Item dist\ClassroomBridge.exe $target -Force
Start-Process $target
Step "Done - Classroom Bridge has restarted. Look for the 'Show log' button in its window."

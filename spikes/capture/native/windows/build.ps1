# Build native/windows/build/glimcapture.dll on Windows.
# Uses zig if it is on PATH (simplest: `winget install -e --id zig.zig`), otherwise
# MSVC cl.exe from a "x64 Native Tools Command Prompt for VS" / Developer PowerShell.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here "build"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$src = Join-Path $here "glimcapture.cpp"
$dll = Join-Path $out "glimcapture.dll"

if (Get-Command zig -ErrorAction SilentlyContinue) {
	Write-Host "Building with zig (x86_64-windows-gnu)..."
	zig c++ -target x86_64-windows-gnu -O2 -shared -std=c++17 -o $dll $src -ld3d11 -ldxgi -luser32 -lgdi32
} elseif (Get-Command cl -ErrorAction SilentlyContinue) {
	Write-Host "Building with MSVC cl.exe..."
	Push-Location $out
	try {
		cl /nologo /O2 /EHsc /std:c++17 /LD $src /Fe:glimcapture.dll d3d11.lib dxgi.lib user32.lib gdi32.lib
	} finally { Pop-Location }
} else {
	throw "Neither zig nor cl.exe found. Install zig (winget install -e --id zig.zig) or open a VS Developer PowerShell."
}
if ($LASTEXITCODE -ne 0) { throw "native build failed ($LASTEXITCODE)" }
Write-Host "OK: $dll"

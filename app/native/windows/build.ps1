# Build app/native/windows/build/glimpse.dll on Windows.
#
# Uses MSVC cl.exe when it is on PATH (a "Developer PowerShell for VS" or the
# ilammy/msvc-dev-cmd action in CI), otherwise zig (`winget install -e --id zig.zig`).
# Set GLIMPSE_NATIVE_TOOL=zig or =msvc to force one.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here "build"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$sources = @("glimpse.cpp", "capture.cpp", "picker.cpp", "frame.cpp") | ForEach-Object { Join-Path $here $_ }
$dll = Join-Path $out "glimpse.dll"
$libs = @("d3d11", "dxgi", "user32", "gdi32", "dwmapi", "version")

$tool = $env:GLIMPSE_NATIVE_TOOL
if (-not $tool) {
	if (Get-Command cl -ErrorAction SilentlyContinue) { $tool = "msvc" }
	elseif (Get-Command zig -ErrorAction SilentlyContinue) { $tool = "zig" }
	else { throw "Neither cl.exe nor zig found. Open a VS Developer PowerShell or install zig (winget install -e --id zig.zig)." }
}

if ($tool -eq "msvc") {
	# /MT: link the C/C++ runtime statically, so glimpse.dll doesn't need VCRUNTIME140.dll on a
	# PC without the Visual C++ redistributable (GLIM-111).
	Write-Host "Building glimpse.dll with MSVC cl.exe..."
	Push-Location $out
	try {
		cl /nologo /O2 /MT /EHsc /std:c++17 /W4 /WX /wd4100 /utf-8 /DUNICODE /D_UNICODE /LD @sources /Fe:glimpse.dll /link ($libs | ForEach-Object { "$_.lib" })
	} finally { Pop-Location }
} elseif ($tool -eq "zig") {
	Write-Host "Building glimpse.dll with zig (x86_64-windows-gnu)..."
	zig c++ -target x86_64-windows-gnu -O2 -shared -std=c++17 -Wall -Wextra -Werror -Wno-unused-parameter -Wno-cast-function-type-mismatch -o $dll @sources ($libs | ForEach-Object { "-l$_" })
} else {
	throw "Unknown GLIMPSE_NATIVE_TOOL '$tool' (expected msvc or zig)"
}
if ($LASTEXITCODE -ne 0) { throw "glimpse.dll build failed ($LASTEXITCODE)" }
Write-Host "OK: $dll"

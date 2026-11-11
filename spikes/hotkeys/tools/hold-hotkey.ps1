# GLIM-14 spike: hold a global hotkey with RegisterHotKey so another app can't.
# Used for the Windows conflict test. Ctrl+C to release.
#
#   powershell -ExecutionPolicy Bypass -File tools\hold-hotkey.ps1            # Alt+Shift+S
#   powershell -ExecutionPolicy Bypass -File tools\hold-hotkey.ps1 -Key L     # Alt+Shift+L
param(
    [string]$Key = "S",
    [switch]$Ctrl,
    [switch]$NoAlt,
    [switch]$NoShift
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class GlimHold {
    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
    [DllImport("user32.dll", SetLastError = true)] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")] public static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
}
"@

$MOD_ALT = 0x1; $MOD_CONTROL = 0x2; $MOD_SHIFT = 0x4; $MOD_NOREPEAT = 0x4000
$mods = $MOD_NOREPEAT
if (-not $NoAlt) { $mods = $mods -bor $MOD_ALT }
if (-not $NoShift) { $mods = $mods -bor $MOD_SHIFT }
if ($Ctrl) { $mods = $mods -bor $MOD_CONTROL }
$vk = [uint32][char]$Key.ToUpper()

$ok = [GlimHold]::RegisterHotKey([IntPtr]::Zero, 1, [uint32]$mods, $vk)
$err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
if (-not $ok) {
    Write-Host "RegisterHotKey FAILED, Win32 error $err (1409 = ERROR_HOTKEY_ALREADY_REGISTERED: someone else holds it)"
    exit 1
}
Write-Host ("Holding hotkey mods=0x{0:X} vk=0x{1:X} ({2}). Press it to see WM_HOTKEY here. Ctrl+C to release." -f $mods, $vk, $Key)
try {
    $msg = New-Object GlimHold+MSG
    while ([GlimHold]::GetMessage([ref]$msg, [IntPtr]::Zero, 0, 0) -gt 0) {
        if ($msg.message -eq 0x0312) { Write-Host ("{0:HH:mm:ss.fff} WM_HOTKEY received by holder" -f (Get-Date)) }
    }
} finally {
    [void][GlimHold]::UnregisterHotKey([IntPtr]::Zero, 1)
    Write-Host "Released."
}

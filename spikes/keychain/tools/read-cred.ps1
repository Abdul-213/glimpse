# Threat-model check (Windows): read a Glimpse credential from an unrelated
# process (PowerShell) with plain CredReadW. Prints only metadata and the
# 12-hex-char SHA-256 fingerprint (same as the app's "fp=").
#   powershell -ExecutionPolicy Bypass -File tools\read-cred.ps1 [-Target dev.glimpse.app/spike-marker]
param([string]$Target = "dev.glimpse.app/spike-marker")

$src = @"
using System;
using System.Runtime.InteropServices;
public static class GlimCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
    public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, UInt32 type, UInt32 flags, out IntPtr cred);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr cred);
  public static byte[] Read(string target, out UInt32 persist, out string user) {
    IntPtr p; persist = 0; user = null;
    if (!CredReadW(target, 1 /* CRED_TYPE_GENERIC */, 0, out p))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      persist = c.Persist; user = c.UserName;
      var b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return b;
    } finally { CredFree(p); }
  }
}
"@
Add-Type -TypeDefinition $src

$persist = [UInt32]0
$user = $null
try {
  $bytes = [GlimCred]::Read($Target, [ref]$persist, [ref]$user)
} catch {
  "CredReadW failed for ${Target}: $($_.Exception.Message) (code $($_.Exception.InnerException.NativeErrorCode))"
  exit 1
}
$sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
$fp = (-join ($sha | ForEach-Object { $_.ToString("x2") })).Substring(0, 12)
"target=$Target user=$user persist=$persist (2=LOCAL_MACHINE, 3=ENTERPRISE) bytes=$($bytes.Length) fp=$fp"
"Read by an unrelated process (powershell pid $PID) with no prompt."

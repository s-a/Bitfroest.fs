$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class FileCaseRename {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long Creation, Access, Write, Change; public uint Attributes; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out Basic info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, IntPtr buffer, uint length);
  static string Extended(string value) { return value.StartsWith(@"\\?\") ? value : value.StartsWith(@"\\") ? @"\\?\UNC\" + value.Substring(2) : @"\\?\" + value; }
  static SafeFileHandle Open(string value, uint access) {
    var handle = CreateFileW(Extended(value), access, access==0x10080 ? 1u : 3u, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
    return handle;
  }
  static Info Read(SafeFileHandle handle) {
    Info info;
    if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if ((info.Attributes & 0x400) != 0) throw new IOException("Reparse points are not permitted.");
    return info;
  }
  static ulong Pair(uint high, uint low) { return ((ulong)high << 32) | low; }
  public static void Rename(string source, string target, string[] roots, string dev, string ino, string size, string mtimeNs, string ctimeNs) {
    source=Path.GetFullPath(source); target=Path.GetFullPath(target);
    if (source == target || !String.Equals(source,target,StringComparison.OrdinalIgnoreCase) || !String.Equals(Path.GetDirectoryName(source),Path.GetDirectoryName(target),StringComparison.OrdinalIgnoreCase)) throw new IOException("Only a case change in the same directory is supported.");
    bool allowed=false;
    foreach(var root in roots) if(source.StartsWith(Path.GetFullPath(root).TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase)) allowed=true;
    if(!allowed) throw new IOException("The path is outside the allowed roots.");
    var parents=new List<SafeFileHandle>();
    try {
      var parent=Path.GetDirectoryName(source);
      var components=new List<string>();
      while(parent!=null) { components.Add(parent); var next=Path.GetDirectoryName(parent); if(next==parent) break; parent=next; }
      components.Reverse();
      foreach(var component in components) { var handle=Open(component,0x80); parents.Add(handle); Read(handle); }
      using(var handle=Open(source,0x10080)) {
        var info=Read(handle);
        decimal nanos=((decimal)Pair((uint)info.Write.dwHighDateTime,(uint)info.Write.dwLowDateTime)-116444736000000000m)*100m;
        Basic basic;
        if(!GetFileInformationByHandleEx(handle,0,out basic,(uint)Marshal.SizeOf(typeof(Basic)))) throw new Win32Exception(Marshal.GetLastWin32Error());
        decimal changeNanos=((decimal)basic.Change-116444736000000000m)*100m;
        if(info.Volume.ToString()!=dev || Pair(info.IndexHigh,info.IndexLow).ToString()!=ino || Pair(info.SizeHigh,info.SizeLow).ToString()!=size || nanos.ToString("0",System.Globalization.CultureInfo.InvariantCulture)!=mtimeNs || changeNanos.ToString("0",System.Globalization.CultureInfo.InvariantCulture)!=ctimeNs) throw new IOException("The source identity or metadata changed.");
        var bytes=Encoding.Unicode.GetBytes(target);
        int rootOffset=IntPtr.Size==8 ? 8 : 4;
        int lengthOffset=rootOffset+IntPtr.Size;
        int nameOffset=lengthOffset+4;
        int count=nameOffset+bytes.Length+2;
        var buffer=Marshal.AllocHGlobal(count);
        try {
          for(int i=0;i<count;i++) Marshal.WriteByte(buffer,i,0);
          Marshal.WriteInt32(buffer,lengthOffset,bytes.Length);
          Marshal.Copy(bytes,0,IntPtr.Add(buffer,nameOffset),bytes.Length);
          if(!SetFileInformationByHandle(handle,3,buffer,(uint)count)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally { Marshal.FreeHGlobal(buffer); }
      }
    } finally { for(int i=parents.Count-1;i>=0;i--) parents[i].Dispose(); }
  }
}
'@
try {
  [FileCaseRename]::Rename([string]$request.source, [string]$request.target, [string[]]$request.roots, [string]$request.expected.dev, [string]$request.expected.ino, [string]$request.expected.size, [string]$request.expected.mtimeNs, [string]$request.expected.ctimeNs)
  @{ ok=$true } | ConvertTo-Json -Compress
} catch {
  @{ ok=$false; code='ERENAME'; message=$_.Exception.GetBaseException().Message } | ConvertTo-Json -Compress
}

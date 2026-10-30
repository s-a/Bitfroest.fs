$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
try {
$compileTimer = [System.Diagnostics.Stopwatch]::StartNew()
Add-Type -ReferencedAssemblies System.dll,System.Windows.Forms.dll -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class FileShellMenu {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct InvokeInfo {
    public int cbSize; public uint fMask; public IntPtr hwnd, lpVerb, lpParameters, lpDirectory;
    public int nShow; public uint dwHotKey; public IntPtr hIcon, lpTitle, lpVerbW, lpParametersW, lpDirectoryW, lpTitleW; public Point ptInvoke;
  }
  [ComImport, Guid("000214E6-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellFolder {
    [PreserveSig] int ParseDisplayName(IntPtr hwnd, IntPtr binding, [MarshalAs(UnmanagedType.LPWStr)] string name, ref uint eaten, out IntPtr pidl, ref uint attributes);
    [PreserveSig] int EnumObjects(IntPtr hwnd, uint flags, out IntPtr enumerator);
    [PreserveSig] int BindToObject(IntPtr pidl, IntPtr binding, ref Guid iid, out IntPtr result);
    [PreserveSig] int BindToStorage(IntPtr pidl, IntPtr binding, ref Guid iid, out IntPtr result);
    [PreserveSig] int CompareIDs(IntPtr parameter, IntPtr first, IntPtr second);
    [PreserveSig] int CreateViewObject(IntPtr hwnd, ref Guid iid, out IntPtr result);
    [PreserveSig] int GetAttributesOf(uint count, [MarshalAs(UnmanagedType.LPArray, SizeParamIndex=0)] IntPtr[] pidls, ref uint attributes);
    [PreserveSig] int GetUIObjectOf(IntPtr hwnd, uint count, [MarshalAs(UnmanagedType.LPArray, SizeParamIndex=1)] IntPtr[] pidls, ref Guid iid, IntPtr reserved, out IntPtr result);
  }
  [ComImport, Guid("000214E4-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IContextMenu {
    [PreserveSig] int QueryContextMenu(IntPtr menu, uint index, uint first, uint last, uint flags);
    [PreserveSig] int InvokeCommand(ref InvokeInfo info);
    [PreserveSig] int GetCommandString(UIntPtr command, uint flags, IntPtr reserved, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, uint length);
  }
  [ComImport, Guid("000214F4-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IContextMenu2 {
    [PreserveSig] int QueryContextMenu(IntPtr menu, uint index, uint first, uint last, uint flags);
    [PreserveSig] int InvokeCommand(ref InvokeInfo info);
    [PreserveSig] int GetCommandString(UIntPtr command, uint flags, IntPtr reserved, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, uint length);
    [PreserveSig] int HandleMenuMsg(uint message, IntPtr wParam, IntPtr lParam);
  }
  [ComImport, Guid("BCFCE0A0-EC17-11D0-8D10-00A0C90F2719"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IContextMenu3 {
    [PreserveSig] int QueryContextMenu(IntPtr menu, uint index, uint first, uint last, uint flags);
    [PreserveSig] int InvokeCommand(ref InvokeInfo info);
    [PreserveSig] int GetCommandString(UIntPtr command, uint flags, IntPtr reserved, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, uint length);
    [PreserveSig] int HandleMenuMsg(uint message, IntPtr wParam, IntPtr lParam);
    [PreserveSig] int HandleMenuMsg2(uint message, IntPtr wParam, IntPtr lParam, out IntPtr result);
  }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern int SHParseDisplayName(string name, IntPtr binding, out IntPtr pidl, uint attributes, out uint found);
  [DllImport("shell32.dll")] static extern int SHBindToParent(IntPtr pidl, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IShellFolder folder, out IntPtr child);
  [DllImport("shell32.dll")] static extern IntPtr ILFindLastID(IntPtr pidl);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr CreatePopupMenu();
  [DllImport("user32.dll")] static extern bool DestroyMenu(IntPtr menu);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool AppendMenu(IntPtr menu, uint flags, UIntPtr id, string text);
  [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr menu);
  [DllImport("user32.dll")] static extern uint GetMenuItemID(IntPtr menu, int position);
  [DllImport("user32.dll")] static extern IntPtr GetSubMenu(IntPtr menu, int position);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetMenuStringW(IntPtr menu, uint item, StringBuilder text, int length, uint flags);
  [DllImport("user32.dll")] static extern uint TrackPopupMenuEx(IntPtr menu, uint flags, int x, int y, IntPtr owner, IntPtr parameters);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int maximum);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  delegate bool EnumWindow(IntPtr hwnd, IntPtr parameter);

  public class Entry { public string label, verb; public bool submenu; }
  public class Interfaces { public bool contextMenu2, contextMenu3; }
  public class Result { public bool ok=true, displayed, invoked, cancelled; public Entry[] entries; public Interfaces interfaces; public string action; }
  class MenuOwner : NativeWindow, IDisposable {
    public IContextMenu2 second; public IContextMenu3 third;
    public MenuOwner(IntPtr owner) { CreateHandle(new CreateParams { Caption="File context menu", Parent=owner, Style=unchecked((int)0x80000000), ExStyle=0x80 }); }
    protected override void WndProc(ref Message message) {
      if (message.Msg==0x117 || message.Msg==0x2B || message.Msg==0x2C || message.Msg==0x120) {
        IntPtr result;
        if (third!=null && third.HandleMenuMsg2((uint)message.Msg,message.WParam,message.LParam,out result)>=0) { message.Result=result; return; }
        if (second!=null && second.HandleMenuMsg((uint)message.Msg,message.WParam,message.LParam)>=0) { message.Result=IntPtr.Zero; return; }
      }
      base.WndProc(ref message);
    }
    public void Dispose() { DestroyHandle(); }
  }
  static string Clean(string value) {
    if (String.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value) || value.IndexOf('\0')>=0) throw new IOException("Ungültige Dateiauswahl für das Systemmenü.");
    var result=Path.GetFullPath(value);
    if(result.Substring(Path.GetPathRoot(result).Length).IndexOf(':')>=0) throw new IOException("Benannte Datenströme unterstützen kein Systemmenü.");
    return result;
  }
  static void CheckPaths(string[] paths, string[] roots) {
    if(paths==null || paths.Length==0 || paths.Length>256 || roots==null || roots.Length==0) throw new IOException("Ungültige Dateiauswahl für das Systemmenü.");
    var parent=Path.GetDirectoryName(Clean(paths[0])); var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach(var supplied in paths) {
      var value=Clean(supplied); bool allowed=false;
      foreach(var root in roots) if(value.StartsWith(Clean(root).TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase)) allowed=true;
      if(!allowed || !seen.Add(value) || !String.Equals(parent,Path.GetDirectoryName(value),StringComparison.OrdinalIgnoreCase)) throw new IOException("Die Dateiauswahl liegt außerhalb des erlaubten Ordners.");
      var current=value;
      while(current!=null) {
        if((File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0) throw new IOException("Verknüpfungen werden im Systemmenü nicht unterstützt.");
        var next=Path.GetDirectoryName(current); if(next==current) break; current=next;
      }
    }
  }
  static IntPtr Owner(string expectedPath, string expectedTitle, bool keyboard, out Point point) {
    IntPtr owner=GetForegroundWindow(); uint pid; GetWindowThreadProcessId(owner,out pid);
    if(owner==IntPtr.Zero || !String.Equals(Process.GetProcessById((int)pid).MainModule.FileName,expectedPath,StringComparison.OrdinalIgnoreCase)) throw new IOException("Das zugehörige Anwendungsfenster ist nicht mehr im Vordergrund.");
    var title=new StringBuilder(1024); GetWindowTextW(owner,title,title.Capacity);
    if(!String.IsNullOrEmpty(expectedTitle) && title.ToString().IndexOf(expectedTitle,StringComparison.OrdinalIgnoreCase)<0) throw new IOException("Das zugehörige Dateimanagerfenster ist nicht mehr im Vordergrund.");
    Rect bounds; if(!GetWindowRect(owner,out bounds)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if(keyboard) point=new Point { X=bounds.Left+(bounds.Right-bounds.Left)/2, Y=bounds.Top+(bounds.Bottom-bounds.Top)/2 };
    else if(!GetCursorPos(out point) || point.X<bounds.Left || point.X>=bounds.Right || point.Y<bounds.Top || point.Y>=bounds.Bottom) throw new IOException("Der Mauszeiger befindet sich außerhalb des zugehörigen Fensters.");
    return owner;
  }
  static bool VisibleHelperWindow() {
    bool visible=false; uint own=(uint)Process.GetCurrentProcess().Id;
    EnumWindows(delegate(IntPtr hwnd,IntPtr unused) { uint pid; GetWindowThreadProcessId(hwnd,out pid); if(pid==own && IsWindowVisible(hwnd)) visible=true; return !visible; },IntPtr.Zero);
    return visible;
  }
  public static void WatchHost(int hostProcessId) {
    if(hostProcessId<=0 || hostProcessId==Process.GetCurrentProcess().Id) throw new IOException("Der zugehörige Erweiterungshost ist ungültig.");
    var host=Process.GetProcessById(hostProcessId);
    var watcher=new System.Threading.Thread(delegate() { try { host.WaitForExit(); } finally { host.Dispose(); Environment.Exit(0); } });
    watcher.IsBackground=true; watcher.Start();
  }
  public static Result Run(string mode, string[] paths, string[] roots, bool keyboard, string expectedProcessPath, string ownerTitle, int hostProcessId, string lockInspectionLabel) {
    if(mode!="inspect" && mode!="show") throw new IOException("Unbekannter Modus für das Systemmenü.");
    if(!Environment.Is64BitProcess || System.Threading.Thread.CurrentThread.GetApartmentState()!=System.Threading.ApartmentState.STA) throw new IOException("Das Systemmenü benötigt einen 64-Bit-STA-Prozess.");
    WatchHost(hostProcessId);
    CheckPaths(paths,roots);
    var allocated=new List<IntPtr>(); IShellFolder folder=null; object context=null; IntPtr menu=IntPtr.Zero, previousDpi=IntPtr.Zero;
    try {
      if(mode=="show") previousDpi=SetThreadDpiAwarenessContext(new IntPtr(-4));
      Point point=new Point(); IntPtr owner=mode=="show" ? Owner(expectedProcessPath,ownerTitle,keyboard,out point) : IntPtr.Zero;
      var children=new IntPtr[paths.Length];
      for(int i=0;i<paths.Length;i++) { IntPtr pidl; uint attributes; Marshal.ThrowExceptionForHR(SHParseDisplayName(paths[i],IntPtr.Zero,out pidl,0,out attributes)); allocated.Add(pidl); children[i]=ILFindLastID(pidl); }
      Guid folderId=typeof(IShellFolder).GUID; IntPtr child; Marshal.ThrowExceptionForHR(SHBindToParent(allocated[0],ref folderId,out folder,out child));
      Guid contextId=typeof(IContextMenu).GUID; IntPtr raw; Marshal.ThrowExceptionForHR(folder.GetUIObjectOf(owner,(uint)children.Length,children,ref contextId,IntPtr.Zero,out raw));
      try { context=Marshal.GetObjectForIUnknown(raw); } finally { Marshal.Release(raw); }
      var first=(IContextMenu)context; var second=context as IContextMenu2; var third=context as IContextMenu3;
      menu=CreatePopupMenu(); if(menu==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      Marshal.ThrowExceptionForHR(first.QueryContextMenu(menu,0,1,0x7FFF,4));
      bool inspectFolder=paths.Length==1 && Directory.Exists(paths[0]);
      if(inspectFolder) {
        if(!AppendMenu(menu,0x800,UIntPtr.Zero,null) || !AppendMenu(menu,0,new UIntPtr(0x8000),lockInspectionLabel)) throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      var entries=new List<Entry>();
      for(int i=0;i<GetMenuItemCount(menu);i++) {
        var label=new StringBuilder(2048); GetMenuStringW(menu,(uint)i,label,label.Capacity,0x400);
        if(label.Length==0) continue;
        uint id=GetMenuItemID(menu,i); var verb=new StringBuilder(256);
        if(id>=1 && id<=0x7FFF) first.GetCommandString(new UIntPtr(id-1),4,IntPtr.Zero,verb,(uint)verb.Capacity);
        entries.Add(new Entry { label=label.ToString(), verb=verb.ToString(), submenu=GetSubMenu(menu,i)!=IntPtr.Zero });
      }
      var result=new Result { entries=entries.ToArray(), interfaces=new Interfaces { contextMenu2=second!=null, contextMenu3=third!=null } };
      if(mode=="inspect") return result;
      using(var window=new MenuOwner(owner)) {
        window.second=second; window.third=third;
        if(Owner(expectedProcessPath,ownerTitle,keyboard,out point)!=owner) throw new IOException("Das aktive Dateimanagerfenster hat sich während der Vorbereitung geändert.");
        uint command=TrackPopupMenuEx(menu,0x102,point.X,point.Y,window.Handle,IntPtr.Zero); result.displayed=true; result.cancelled=command==0;
        if(command==0x8000 && inspectFolder) { result.action="inspect-locks"; result.invoked=true; return result; }
        PostMessage(owner,0,IntPtr.Zero,IntPtr.Zero);
        if(command!=0) {
          CheckPaths(paths,roots);
          var invoke=new InvokeInfo { cbSize=Marshal.SizeOf(typeof(InvokeInfo)), fMask=0x20004000, hwnd=owner, lpVerb=new IntPtr(command-1), lpVerbW=new IntPtr(command-1), nShow=1, ptInvoke=point };
          Marshal.ThrowExceptionForHR(first.InvokeCommand(ref invoke)); result.invoked=true;
          while(VisibleHelperWindow()) { Application.DoEvents(); System.Threading.Thread.Sleep(25); }
        }
      }
      return result;
    } finally {
      if(menu!=IntPtr.Zero) DestroyMenu(menu);
      if(context!=null) Marshal.FinalReleaseComObject(context);
      if(folder!=null) Marshal.FinalReleaseComObject(folder);
      foreach(var pidl in allocated) Marshal.FreeCoTaskMem(pidl);
      if(previousDpi!=IntPtr.Zero) SetThreadDpiAwarenessContext(previousDpi);
    }
  }
}
'@
  $compileTimer.Stop()
  $nativeTimer = [System.Diagnostics.Stopwatch]::StartNew()
  $result = [FileShellMenu]::Run([string]$request.mode, [string[]]$request.paths, [string[]]$request.roots, [bool]$request.keyboard, [string]$request.expectedProcessPath, [string]$request.ownerTitle, [int]$request.hostProcessId, [string]$request.lockInspectionLabel)
  $nativeTimer.Stop()
  $result | Add-Member -NotePropertyName timing -NotePropertyValue @{ compileMilliseconds = $compileTimer.ElapsedMilliseconds; nativeMilliseconds = $nativeTimer.ElapsedMilliseconds }
  $result | ConvertTo-Json -Depth 8 -Compress
} catch {
  $failure = $_.Exception
  while ($failure.InnerException) { $failure = $failure.InnerException }
  @{ ok = $false; message = $failure.Message } | ConvertTo-Json -Compress
}

using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Diagnostics;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32;

public static class FolderLocks {
  public class Entry { public int pid; public string started, name, executable, commandLine, file, kind, handle, module; }
  public class Result { public bool ok = true; public Entry[] rows = new Entry[0]; public int inaccessible, changed; public string[] errors = new string[0]; public string backup; }
  [StructLayout(LayoutKind.Sequential)] struct HandleEntry { public IntPtr Object, Process, Handle; public uint Access; public ushort Backtrace, Type; public uint Attributes, Reserved; }
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int kind, IntPtr data, int size, out int needed);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr process, IntPtr source, IntPtr target, out IntPtr copy, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder path, uint size, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessCritical(IntPtr process, out bool critical);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsWow64Process(IntPtr process, out bool wow64);
  [DllImport("kernel32.dll", CharSet=CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module, string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateRemoteThread(IntPtr process, IntPtr attributes, UIntPtr stack, IntPtr address, IntPtr parameter, uint flags, out uint threadId);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeThread(IntPtr thread, out uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool MoveFileEx(string source, string destination, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DebugActiveProcess(int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DebugActiveProcessStop(int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DebugSetProcessKillOnExit(bool kill);
  [StructLayout(LayoutKind.Explicit, Size=176)] struct DebugEvent {
    [FieldOffset(0)] public uint Code; [FieldOffset(4)] public uint Process; [FieldOffset(8)] public uint Thread; [FieldOffset(16)] public IntPtr File;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WaitForDebugEvent(out DebugEvent data, uint milliseconds);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo { public int cb; public string reserved, desktop, title; public int x, y, width, height, xChars, yChars, fill, flags; public short show, reservedSize; public IntPtr reservedData, input, output, error; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Id, ThreadId; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
  [ThreadStatic] static bool debuggerPrepared;
  static void PrepareDebugger() {
    if (debuggerPrepared) return;
    string executable = Path.Combine(Environment.SystemDirectory, "cmd.exe");
    var startup = new StartupInfo(); startup.cb = Marshal.SizeOf(typeof(StartupInfo)); ProcessInfo process;
    if (!CreateProcess(executable, new StringBuilder("\"" + executable + "\" /d /c exit 0"), IntPtr.Zero, IntPtr.Zero, false, 0x08000002, IntPtr.Zero, null, ref startup, out process)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      if (!DebugSetProcessKillOnExit(false)) { Console.Error.WriteLine("Die eigene Debugvorbereitung konnte nicht abgesichert werden."); Environment.Exit(70); }
      if (!DebugActiveProcessStop((int)process.Id)) { Console.Error.WriteLine("Die eigene Debugvorbereitung konnte nicht freigegeben werden."); Environment.Exit(70); }
      debuggerPrepared = true;
    } finally { CloseHandle(process.Thread); CloseHandle(process.Process); }
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegGetValue(IntPtr key, string subkey, string name, uint flags, out uint type, byte[] data, ref uint size);
  static byte[] PendingBytes() {
    uint size = 0, type; var root = new IntPtr(unchecked((int)0x80000002));
    const string key = @"SYSTEM\CurrentControlSet\Control\Session Manager";
    int status = RegGetValue(root, key, "PendingFileRenameOperations", 0x10000020, out type, null, ref size);
    if (status == 2) return null;
    if (status != 0) throw new Win32Exception(status);
    var bytes = new byte[size]; status = RegGetValue(root, key, "PendingFileRenameOperations", 0x10000020, out type, bytes, ref size);
    if (status != 0 || type != 7) throw new IOException("Die Neustartwarteschlange konnte nicht gelesen werden.");
    return bytes.Take((int)size).ToArray();
  }
  static List<string[]> PendingPairs(byte[] bytes) {
    var result = new List<string[]>(); if (bytes == null) return result;
    if (bytes.Length % 2 != 0) throw new IOException("Ungültiges Format der Neustartwarteschlange.");
    var parts = Encoding.Unicode.GetString(bytes).Split('\0');
    for (int i=0; i<parts.Length && parts[i].Length>0; i+=2) { if (i+1>=parts.Length) throw new IOException("Unvollständige Neustartwarteschlange."); result.Add(new string[] { parts[i], parts[i+1] }); }
    return result;
  }
  static string Full(string value) { return Path.GetFullPath(value).TrimEnd('\\'); }
  static bool Inside(string value, string root) { value = Full(value); root = Full(root); return value.Equals(root, StringComparison.OrdinalIgnoreCase) || value.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase); }
  static string HandlePath(IntPtr handle) {
    if (GetFileType(handle) != 1) return null;
    var text = new StringBuilder(32768); uint size = GetFinalPathNameByHandle(handle, text, (uint)text.Capacity, 0);
    if (size == 0 || size >= text.Capacity) return null;
    string value = text.ToString();
    if (value.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) value = "\\\\" + value.Substring(8);
    else if (value.StartsWith("\\\\?\\")) value = value.Substring(4);
    return value;
  }
  static List<HandleEntry> Handles(string directory) {
    if (!Environment.Is64BitProcess || Environment.OSVersion.Version.Major < 10) throw new IOException("Die Handleuntersuchung benötigt Windows 10/11 x64.");
    IntPtr sentinel = CreateFile(directory, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (sentinel == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr buffer = IntPtr.Zero;
    try {
      int size = 1048576, needed, status;
      while (true) {
        buffer = Marshal.AllocHGlobal(size); status = NtQuerySystemInformation(64, buffer, size, out needed);
        if (status == 0) break;
        Marshal.FreeHGlobal(buffer); buffer = IntPtr.Zero;
        if (status != unchecked((int)0xC0000004) || size >= 268435456) throw new IOException("Die Windows-Handleabfrage ist nicht verfügbar: " + status.ToString("X8"));
        size = Math.Max(checked(size * 2), needed);
      }
      long count = Marshal.ReadInt64(buffer); int stride = Marshal.SizeOf(typeof(HandleEntry));
      if (stride != 40 || count < 0 || count > (size - 16) / stride) throw new IOException("Das Windows-Handleformat wird nicht unterstützt.");
      var all = new List<HandleEntry>(); ushort fileType = 0;
      for (long i = 0; i < count; i++) {
        var item = (HandleEntry)Marshal.PtrToStructure(new IntPtr(buffer.ToInt64() + 16 + i * stride), typeof(HandleEntry));
        all.Add(item);
        if (item.Process.ToInt64() == Process.GetCurrentProcess().Id && item.Handle == sentinel) fileType = item.Type;
      }
      if (fileType == 0) throw new IOException("Der Windows-Dateihandletyp konnte nicht bestimmt werden.");
      return all.Where(item => item.Type == fileType).ToList();
    } finally { if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer); CloseHandle(sentinel); }
  }
  static Entry Describe(int pid, string file, string kind) {
    using (var process = Process.GetProcessById(pid)) {
      return new Entry { pid=pid, started=process.StartTime.ToUniversalTime().Ticks.ToString(), name=process.ProcessName, executable=process.MainModule.FileName, file=file, kind=kind };
    }
  }
  public static Result Scan(string directory) {
    var result = new List<Entry>(); var denied = new HashSet<int>(); var processes = new Dictionary<int, IntPtr>();
    int own = Process.GetCurrentProcess().Id;
    try {
      foreach (var item in Handles(directory)) {
        long processId = item.Process.ToInt64();
        if (processId <= 4 || processId > int.MaxValue || processId == own) continue;
        int pid = (int)processId; IntPtr process;
        if (!processes.TryGetValue(pid, out process)) { process = OpenProcess(0x40, false, pid); processes[pid] = process; if (process == IntPtr.Zero) denied.Add(pid); }
        if (process == IntPtr.Zero) continue;
        IntPtr copy;
        if (!DuplicateHandle(process, item.Handle, GetCurrentProcess(), out copy, 0, false, 2)) { denied.Add(pid); continue; }
        try {
          string file = HandlePath(copy);
          if (file == null) { if (GetFileType(copy) == 1) denied.Add(pid); continue; }
          if (!Inside(file, directory)) continue;
          try { var row = Describe(pid, file, "handle"); row.handle = item.Handle.ToInt64().ToString(); result.Add(row); }
          catch { denied.Add(pid); }
        } finally { CloseHandle(copy); }
      }
      foreach (var process in Process.GetProcesses()) {
        using (process) {
          if (process.Id <= 4 || process.Id == own) continue;
          try {
            string executable = process.MainModule.FileName;
            foreach (ProcessModule module in process.Modules) {
              string file = module.FileName; if (!Inside(file, directory)) continue;
              var row = Describe(process.Id, file, file.Equals(executable, StringComparison.OrdinalIgnoreCase) ? "image" : "module");
              row.module = module.BaseAddress.ToInt64().ToString(); result.Add(row);
            }
          } catch { denied.Add(process.Id); }
        }
      }
      return new Result { rows=result.ToArray(), inaccessible=denied.Count };
    } finally { foreach (var process in processes.Values) if (process != IntPtr.Zero) CloseHandle(process); }
  }
  static Process Verify(Entry row, int hostPid) {
    if (row.pid <= 4 || row.pid == hostPid || row.pid == Process.GetCurrentProcess().Id) throw new IOException("Dieser Prozess darf hier nicht verändert werden.");
    var process = Process.GetProcessById(row.pid);
    try {
      if (process.StartTime.ToUniversalTime().Ticks.ToString() != row.started) throw new IOException("Die Prozessidentität hat sich geändert. Bitte aktualisieren.");
      bool critical;
      if (!IsProcessCritical(process.Handle, out critical) || critical) throw new IOException("Geschützte oder kritische Prozesse dürfen nicht verändert werden.");
      return process;
    } catch { process.Dispose(); throw; }
  }
  static void Unload(Entry row, Process process) {
    if (!row.file.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)) throw new IOException("Dieses geladene Modul kann nicht freigegeben werden.");
    bool wow64; if (!IsWow64Process(process.Handle, out wow64) || wow64) throw new IOException("32-Bit-Module können durch den 64-Bit-Adapter nicht entladen werden.");
    IntPtr function = GetProcAddress(GetModuleHandle("kernel32.dll"), "FreeLibrary");
    ProcessModule owner = null;
    using (var current = Process.GetCurrentProcess()) foreach (ProcessModule module in current.Modules) if (function.ToInt64() >= module.BaseAddress.ToInt64() && function.ToInt64() < module.BaseAddress.ToInt64() + module.ModuleMemorySize) owner = module;
    if (function == IntPtr.Zero || owner == null) throw new IOException("Die Windows-Modulfreigabe ist nicht verfügbar.");
    ProcessModule found = null, kernel = null;
    foreach (ProcessModule module in process.Modules) { if (module.BaseAddress.ToInt64().ToString() == row.module && module.FileName.Equals(row.file, StringComparison.OrdinalIgnoreCase)) found = module; if (module.FileName.Equals(owner.FileName, StringComparison.OrdinalIgnoreCase) && module.ModuleMemorySize == owner.ModuleMemorySize) kernel = module; }
    if (found == null || kernel == null) throw new IOException("Die Modulidentität hat sich geändert. Bitte aktualisieren.");
    long offset = function.ToInt64() - owner.BaseAddress.ToInt64();
    IntPtr remote = OpenProcess(0x43A, false, row.pid); if (remote == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      uint threadId; IntPtr thread = CreateRemoteThread(remote, IntPtr.Zero, UIntPtr.Zero, new IntPtr(kernel.BaseAddress.ToInt64() + offset), found.BaseAddress, 0, out threadId);
      if (thread == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      try { if (WaitForSingleObject(thread, 5000) != 0) throw new IOException("Das Modul wurde nicht rechtzeitig freigegeben. Bitte erneut untersuchen."); uint code; if (!GetExitCodeThread(thread, out code) || code == 0) throw new IOException("Das Modul konnte nicht freigegeben werden."); }
      finally { CloseHandle(thread); }
    } finally { CloseHandle(remote); }
  }
  public static Result Act(string action, string directory, Entry[] rows, int hostPid) {
    var errors = new List<string>(); var killed = new HashSet<int>(); int changed = 0;
    foreach (var row in rows) {
      try {
        if (!Inside(row.file, directory)) throw new IOException("Die Sperre gehört nicht zum untersuchten Ordner.");
        if (action == "terminate" && killed.Contains(row.pid)) continue;
        using (var process = Verify(row, hostPid)) {
          if (action == "terminate") { process.Kill(); if (!process.WaitForExit(5000)) throw new IOException("Der Prozess wurde nicht rechtzeitig beendet."); killed.Add(row.pid); changed++; continue; }
          if (action != "unlock") throw new IOException("Unbekannte Sperrenaktion.");
          if (row.kind == "image") throw new IOException("Eine laufende Programmdatei kann erst nach dem Beenden ihres Prozesses freigegeben werden.");
          if (row.kind == "module") { Unload(row, process); changed++; continue; }
          if (row.kind != "handle") throw new IOException("Ungültiger Sperrentyp.");
          PrepareDebugger();
          if (!DebugActiveProcess(row.pid)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Der Prozess kann für die sichere Handleprüfung nicht angehalten werden.");
          try {
            if (!DebugSetProcessKillOnExit(false)) throw new Win32Exception(Marshal.GetLastWin32Error());
            DebugEvent debug;
            if (!WaitForDebugEvent(out debug, 3000)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (debug.Code == 3 && debug.File != IntPtr.Zero) CloseHandle(debug.File);
            IntPtr source = OpenProcess(0x40, false, row.pid); if (source == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
              IntPtr copy, original = new IntPtr(long.Parse(row.handle));
              if (!DuplicateHandle(source, original, GetCurrentProcess(), out copy, 0, false, 2)) throw new Win32Exception(Marshal.GetLastWin32Error());
              try {
                string actual = HandlePath(copy); if (actual == null || !actual.Equals(row.file, StringComparison.OrdinalIgnoreCase)) throw new IOException("Das Dateihandle hat sich geändert. Bitte aktualisieren.");
                IntPtr closed;
                if (!DuplicateHandle(source, original, GetCurrentProcess(), out closed, 0, false, 3)) throw new Win32Exception(Marshal.GetLastWin32Error());
                CloseHandle(closed); changed++;
              } finally { CloseHandle(copy); }
            } finally { CloseHandle(source); }
          } finally { if (!DebugActiveProcessStop(row.pid)) { Console.Error.WriteLine("Die Debugverbindung wird zur Prozessfreigabe beendet."); Environment.Exit(70); } }
        }
      } catch (Exception error) { errors.Add("PID " + row.pid + ": " + error.Message); }
    }
    return new Result { changed=changed, errors=errors.ToArray() };
  }
  public static Result Rename(string source, string destination) {
    if (!MoveFileEx(source, destination, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return new Result { changed=1 };
  }
  static void Collect(string directory, List<string> files) {
    if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new IOException("Verknüpfungen werden nicht für den Neustart vorgemerkt.");
    foreach (var item in Directory.EnumerateFileSystemEntries(directory)) {
      var attributes = File.GetAttributes(item);
      if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Verknüpfungen werden nicht für den Neustart vorgemerkt.");
      if ((attributes & FileAttributes.Directory) != 0) Collect(item, files); else files.Add(item);
    }
    files.Add(directory);
  }
  public static Result Schedule(string directory, string backup) {
    if (!Path.IsPathRooted(backup) || File.Exists(backup)) throw new IOException("Ein neuer absoluter Sicherungspfad ist erforderlich.");
    var files = new List<string>(); Collect(directory, files);
    const string keyName = @"SYSTEM\CurrentControlSet\Control\Session Manager"; const string name = "PendingFileRenameOperations";
    using (var key = Registry.LocalMachine.OpenSubKey(keyName, true)) {
      if (key == null) throw new IOException("Die Windows-Neustartwarteschlange ist nicht verfügbar.");
      byte[] before = PendingBytes(); var pairs = PendingPairs(before);
      Directory.CreateDirectory(Path.GetDirectoryName(backup));
      using (var stream = new FileStream(backup, FileMode.CreateNew, FileAccess.Write, FileShare.None))
      using (var writer = new StreamWriter(stream, Encoding.Unicode)) {
        writer.WriteLine("Windows Registry Editor Version 5.00\r\n\r\n[HKEY_LOCAL_MACHINE\\" + keyName + "]");
        if (before == null) writer.WriteLine("\"" + name + "\"=-");
        else {
          writer.WriteLine("\"" + name + "\"=hex(7):" + string.Join(",", before.Select(value => value.ToString("x2")).ToArray()));
        }
      }
      if (!File.Exists(backup) || new FileInfo(backup).Length == 0) throw new IOException("Die Sicherung der Neustartwarteschlange ist fehlgeschlagen.");
      var current = PendingBytes();
      if (before == null ? current != null : current == null || !current.SequenceEqual(before)) throw new IOException("Die Neustartwarteschlange wurde zwischenzeitlich verändert. Bitte erneut versuchen.");
      foreach (string file in files) if (!MoveFileEx(file, null, 4)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Neustartlöschung teilweise vorgemerkt. Sicherung: " + backup);
      var after = PendingPairs(PendingBytes());
      if (after.Count < pairs.Count + files.Count || pairs.Where((pair, index) => !pair.SequenceEqual(after[index])).Any()) throw new IOException("Die Neustartwarteschlange konnte nicht vollständig geprüft werden. Sicherung: " + backup);
      foreach (string file in files) {
        string expected = file.StartsWith("\\\\") ? "\\??\\UNC\\" + file.Substring(2) : "\\??\\" + file;
        if (!after.Skip(pairs.Count).Any(pair => pair[0].Equals(expected, StringComparison.OrdinalIgnoreCase) && pair[1] == "")) throw new IOException("Ein Neustart-Löschauftrag fehlt nach dem Schreiben. Sicherung: " + backup);
      }
      return new Result { changed=files.Count, backup=backup };
    }
  }
}

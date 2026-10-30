$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$requestText = [Console]::In.ReadToEnd()
if ($requestText.Length -gt 1048576) { throw 'Clipboard request exceeds limit.' }
$request = $requestText | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class FileClipboardBridge {
    public static readonly List<string> NotificationErrors = new List<string>();
    [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern bool EmptyClipboard();
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint exStyle, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
    [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint format, IntPtr memory);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr memory);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern uint DragQueryFile(IntPtr drop, uint index, StringBuilder name, uint size);
    [DllImport("ole32.dll")] static extern int OleGetClipboard(out IDataObject data);
    [DllImport("ole32.dll")] static extern int OleInitialize(IntPtr reserved);
    [DllImport("ole32.dll")] public static extern void OleUninitialize();
    [DllImport("ole32.dll")] static extern void ReleaseStgMedium(ref STGMEDIUM medium);

    public sealed class Selection {
        public string[] paths;
        public string mode;
        public string token;
    }
    public static void Initialize() {
        int result = OleInitialize(IntPtr.Zero);
        if (result < 0) Marshal.ThrowExceptionForHR(result);
    }
    static FORMATETC Format(uint id) {
        return new FORMATETC { cfFormat = unchecked((short)id), dwAspect = DVASPECT.DVASPECT_CONTENT, lindex = -1, tymed = TYMED.TYMED_HGLOBAL };
    }
    static uint Effect(IDataObject data) {
        FORMATETC format = Format(RegisterClipboardFormat("Preferred DropEffect"));
        if (data.QueryGetData(ref format) != 0) return 1;
        STGMEDIUM medium;
        data.GetData(ref format, out medium);
        try {
            IntPtr memory = GlobalLock(medium.unionmember);
            if (memory == IntPtr.Zero) throw new InvalidOperationException("Clipboard memory is unavailable.");
            try { return unchecked((uint)Marshal.ReadInt32(memory)); }
            finally { GlobalUnlock(medium.unionmember); }
        } finally { ReleaseStgMedium(ref medium); }
    }
    public static Selection Read() {
        uint before = GetClipboardSequenceNumber();
        IDataObject data;
        int result = OleGetClipboard(out data);
        if (result != 0) Marshal.ThrowExceptionForHR(result);
        try {
            FORMATETC format = Format(15);
            string[] paths = new string[0];
            uint effect = 1;
            if (data != null && data.QueryGetData(ref format) == 0) {
                STGMEDIUM medium;
                data.GetData(ref format, out medium);
                try {
                    uint count = DragQueryFile(medium.unionmember, UInt32.MaxValue, null, 0);
                    if (count > 1024) throw new InvalidOperationException("Too many clipboard files.");
                    List<string> names = new List<string>();
                    for (uint index = 0; index < count; index++) {
                        uint length = DragQueryFile(medium.unionmember, index, null, 0);
                        if (length > 4096) throw new InvalidOperationException("Clipboard path exceeds limit.");
                        StringBuilder name = new StringBuilder((int)length + 1);
                        DragQueryFile(medium.unionmember, index, name, length + 1);
                        names.Add(name.ToString().Replace('\\', '/'));
                    }
                    paths = names.ToArray();
                } finally { ReleaseStgMedium(ref medium); }
                effect = Effect(data);
            }
            uint after = GetClipboardSequenceNumber();
            if (before != after) throw new InvalidOperationException("Clipboard changed while being read.");
            return new Selection { paths = paths, mode = effect == 2 ? "move" : effect == 1 || effect == 0 ? "copy" : "link", token = after.ToString(System.Globalization.CultureInfo.InvariantCulture) };
        } finally { if (data != null && Marshal.IsComObject(data)) Marshal.ReleaseComObject(data); }
    }
    static IntPtr Memory(byte[] bytes) {
        IntPtr block = GlobalAlloc(2, new UIntPtr((uint)bytes.Length));
        if (block == IntPtr.Zero) throw new InvalidOperationException("Clipboard allocation failed.");
        IntPtr memory = GlobalLock(block);
        if (memory == IntPtr.Zero) { GlobalFree(block); throw new InvalidOperationException("Clipboard memory is unavailable."); }
        try { Marshal.Copy(bytes, 0, memory, bytes.Length); }
        finally { GlobalUnlock(block); }
        return block;
    }
    static void Put(uint format, byte[] bytes) {
        IntPtr block = Memory(bytes);
        if (SetClipboardData(format, block) == IntPtr.Zero) { GlobalFree(block); throw new InvalidOperationException("Clipboard write failed."); }
    }
    public static bool Replace(string token, string[] paths, string mode) {
        IntPtr owner = CreateWindowEx(0, "STATIC", "", 0, 0, 0, 0, 0, new IntPtr(-3), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (owner == IntPtr.Zero) throw new InvalidOperationException("Clipboard owner cannot be created.");
        if (!OpenClipboard(owner)) { DestroyWindow(owner); throw new InvalidOperationException("Clipboard is in use."); }
        try {
            if (!String.IsNullOrEmpty(token) && GetClipboardSequenceNumber().ToString(System.Globalization.CultureInfo.InvariantCulture) != token) return false;
            if (!EmptyClipboard()) throw new InvalidOperationException("Clipboard cannot be replaced.");
            if (paths.Length != 0) {
                byte[] names = Encoding.Unicode.GetBytes(String.Join("\0", paths.Select(Path.GetFullPath).ToArray()) + "\0\0");
                byte[] drop = new byte[20 + names.Length];
                Buffer.BlockCopy(BitConverter.GetBytes(20), 0, drop, 0, 4);
                Buffer.BlockCopy(BitConverter.GetBytes(1), 0, drop, 16, 4);
                Buffer.BlockCopy(names, 0, drop, 20, names.Length);
                Put(15, drop);
                Put(RegisterClipboardFormat("Preferred DropEffect"), BitConverter.GetBytes(mode == "move" ? 2 : 1));
            }
            return true;
        } finally { CloseClipboard(); DestroyWindow(owner); }
    }
    static void SetEffect(IDataObject data, string name, int effect) {
        FORMATETC format = Format(RegisterClipboardFormat(name));
        STGMEDIUM medium = new STGMEDIUM { tymed = TYMED.TYMED_HGLOBAL, unionmember = Memory(BitConverter.GetBytes(effect)) };
        try { data.SetData(ref format, ref medium, false); }
        catch (Exception error) {
            if (error.HResult != unchecked((int)0x80004001) && error.HResult != unchecked((int)0x80040064) && error.HResult != unchecked((int)0x80004005)) throw;
            NotificationErrors.Add(name + ": 0x" + unchecked((uint)error.HResult).ToString("X8"));
        }
        finally { ReleaseStgMedium(ref medium); }
    }
    public static bool Acknowledge(string token, string[] paths, string mode, string[] remaining) {
        Selection current = Read();
        if (current.token != token || current.mode != mode || !current.paths.SequenceEqual(paths, StringComparer.OrdinalIgnoreCase)) return false;
        if (remaining.Length == 0 && mode == "move") {
            IDataObject data;
            int result = OleGetClipboard(out data);
            if (result != 0) Marshal.ThrowExceptionForHR(result);
            try {
                if (GetClipboardSequenceNumber().ToString(System.Globalization.CultureInfo.InvariantCulture) != token) return false;
                SetEffect(data, "Performed DropEffect", 0);
                SetEffect(data, "Paste Succeeded", 2);
            } finally { if (data != null && Marshal.IsComObject(data)) Marshal.ReleaseComObject(data); }
        }
        return Replace(token, remaining, mode);
    }
}
'@
[FileClipboardBridge]::Initialize()
try {
if ($request.action -eq 'read') {
    [FileClipboardBridge]::Read() | ConvertTo-Json -Compress
} elseif ($request.action -eq 'write') {
    $paths = @($request.paths | ForEach-Object { [string]$_ })
    if ($paths.Count -eq 0 -or $paths.Count -gt 1024 -or $request.mode -notin @('copy', 'move')) { throw 'Invalid clipboard selection.' }
    $null = [FileClipboardBridge]::Replace($null, [string[]]$paths, [string]$request.mode)
    [FileClipboardBridge]::Read() | ConvertTo-Json -Compress
} elseif ($request.action -eq 'ack') {
    $matched = [FileClipboardBridge]::Acknowledge([string]$request.token, [string[]]@($request.paths), [string]$request.mode, [string[]]@($request.remainingPaths))
    @{ matched = $matched; notificationErrors = @([FileClipboardBridge]::NotificationErrors.ToArray()) } | ConvertTo-Json -Compress
} else { throw 'Unsupported clipboard action.' }
} finally { [FileClipboardBridge]::OleUninitialize() }

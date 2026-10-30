$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Diagnostics;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
public static class CancellableFileCopy {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long Creation, Access, Write, Change; public uint Attributes; }
  delegate uint Progress(long total, long transferred, long streamSize, long streamTransferred, uint streamNumber, uint reason, IntPtr source, IntPtr destination, IntPtr data);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CopyFileExW(string source, string destination, Progress progress, IntPtr data, IntPtr cancel, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out Basic info, uint length);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr handle, byte[] bytes, uint length, out uint written, IntPtr overlapped);
  static readonly object gate = new object();
  static readonly HashSet<string> cancelled = new HashSet<string>();
  static bool stopping;
  static string activeId;
  static IntPtr cancelPointer;
  static string Extended(string value) { return value.StartsWith(@"\\?\") ? value : value.StartsWith(@"\\") ? @"\\?\UNC\" + value.Substring(2) : @"\\?\" + value; }
  static SafeFileHandle Open(string value, uint access, uint share) {
    var handle=CreateFileW(Extended(value),access,share,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
    if(handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
    return handle;
  }
  static Info Read(SafeFileHandle handle) {
    Info info;
    if(!GetFileInformationByHandle(handle,out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if((info.Attributes&0x400)!=0) throw new IOException("Reparse points are not permitted.");
    return info;
  }
  static ulong Pair(uint high,uint low) { return ((ulong)high<<32)|low; }
  static string Nanoseconds(long value) { return ((value-116444736000000000L)*100L).ToString(); }
  static bool IsCancelled(string id) { lock(gate) return stopping || cancelled.Contains(id); }
  static void Cancel(string id) {
    lock(gate) {
      cancelled.Add(id);
      if(activeId==id && cancelPointer!=IntPtr.Zero) Marshal.WriteInt32(cancelPointer,1);
    }
  }
  static void Stop() {
    lock(gate) {
      stopping=true;
      if(cancelPointer!=IntPtr.Zero) Marshal.WriteInt32(cancelPointer,1);
    }
  }
  static bool WriteLine(string value) {
    try {
      var bytes=Encoding.UTF8.GetBytes(value+"\n"); uint written;
      if(WriteFile(GetStdHandle(-11),bytes,(uint)bytes.Length,out written,IntPtr.Zero) && written==bytes.Length) return true;
    } catch(Exception) {
    }
    Stop(); return false;
  }
  static Dictionary<string,object> Result(string id,bool ok,bool aborted,int code,string message) {
    return new Dictionary<string,object> { {"type","result"},{"id",id},{"ok",ok},{"cancelled",aborted},{"code",code},{"message",message} };
  }
  static Dictionary<string,object> Copy(Dictionary<string,object> request) {
    string id=(string)request["id"];
    var handles=new List<SafeFileHandle>();
    IntPtr pointer=Marshal.AllocHGlobal(4);
    lock(gate) { activeId=id; cancelPointer=pointer; Marshal.WriteInt32(pointer,stopping || cancelled.Contains(id) ? 1 : 0); }
    try {
      if(IsCancelled(id)) return Result(id,false,true,1235,null);
      string source=Path.GetFullPath((string)request["source"]), target=Path.GetFullPath((string)request["target"]);
      var roots=(IEnumerable)request["roots"];
      var expected=(Dictionary<string,object>)request["expected"];
      foreach(var value in new[]{source,target}) {
        bool allowed=false;
        foreach(var root in roots) if(value.StartsWith(Path.GetFullPath((string)root).TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase)) allowed=true;
        if(!allowed) throw new IOException("The path is outside the allowed roots.");
        for(var parent=Path.GetDirectoryName(value); parent!=null; parent=Path.GetDirectoryName(parent)) {
          if(IsCancelled(id)) return Result(id,false,true,1235,null);
          var handle=Open(parent,0x80,3); handles.Add(handle); Read(handle);
        }
      }
      var sourceHandle=Open(source,0x80000080,1); handles.Add(sourceHandle);
      var info=Read(sourceHandle); Basic basic;
      if(!GetFileInformationByHandleEx(sourceHandle,0,out basic,(uint)Marshal.SizeOf(typeof(Basic)))) throw new Win32Exception(Marshal.GetLastWin32Error());
      if(info.Volume.ToString()!=Convert.ToString(expected["dev"]) || Pair(info.IndexHigh,info.IndexLow).ToString()!=Convert.ToString(expected["ino"]) || Pair(info.SizeHigh,info.SizeLow).ToString()!=Convert.ToString(expected["size"]) || Nanoseconds(basic.Write)!=Convert.ToString(expected["mtimeNs"]) || Nanoseconds(basic.Change)!=Convert.ToString(expected["ctimeNs"])) throw new IOException("The source changed before copying.");
      if(IsCancelled(id)) return Result(id,false,true,1235,null);
      long last=0;
      if(!WriteLine("{\"type\":\"progress\",\"id\":\""+id+"\",\"transferred\":0,\"total\":"+Pair(info.SizeHigh,info.SizeLow)+"}")) return Result(id,false,true,1235,null);
      var clock=Stopwatch.StartNew(); long lastTime=0;
      Progress callback=(total,transferred,streamSize,streamTransferred,streamNumber,reason,src,dst,data)=>{
        if(IsCancelled(id)) return 1u;
        if(last!=transferred && (transferred==total || clock.ElapsedMilliseconds-lastTime>=50)) {
          if(!WriteLine("{\"type\":\"progress\",\"id\":\""+id+"\",\"transferred\":"+transferred+",\"total\":"+total+"}")) return 1u;
          last=transferred; lastTime=clock.ElapsedMilliseconds;
        }
        return IsCancelled(id) ? 1u : 0u;
      };
      bool success=CopyFileExW(Extended(source),Extended(target),callback,IntPtr.Zero,pointer,1);
      int error=Marshal.GetLastWin32Error(); GC.KeepAlive(callback);
      return Result(id,success,!success && error==1235 && IsCancelled(id),success ? 0 : error,null);
    } catch(Exception error) {
      var native=error as Win32Exception;
      return Result(id,false,IsCancelled(id),native==null ? -1 : native.NativeErrorCode,error.GetBaseException().Message);
    } finally {
      foreach(var handle in handles) handle.Dispose();
      lock(gate) { activeId=null; cancelPointer=IntPtr.Zero; cancelled.Remove(id); }
      Marshal.FreeHGlobal(pointer);
    }
  }
  public static void Run() {
    var requests=new BlockingCollection<Dictionary<string,object>>();
    if(!WriteLine("{\"type\":\"ready\"}")) return;
    var reader=Task.Run(()=>{
      var parser=new JavaScriptSerializer();
      try {
        string line;
        while((line=Console.ReadLine())!=null) {
          if(line.Length>1048576) break;
          var request=parser.DeserializeObject(line) as Dictionary<string,object>;
          if(request==null || !request.ContainsKey("type")) break;
          string type=Convert.ToString(request["type"]);
          if(type=="shutdown") break;
          string id=request.ContainsKey("id") ? request["id"] as string : null;
          long number;
          if(id==null || id.Length>20 || !long.TryParse(id,out number) || number<1) break;
          if(type=="cancel") Cancel(id);
          else if(type=="copy") requests.Add(request);
          else break;
        }
      } catch(Exception) {
      } finally { Stop(); requests.CompleteAdding(); }
    });
    var serializer=new JavaScriptSerializer();
    foreach(var request in requests.GetConsumingEnumerable()) {
      if(stopping) break;
      if(!WriteLine(serializer.Serialize(Copy(request)))) return;
    }
    reader.Wait(); requests.Dispose();
  }
}
'@
[CancellableFileCopy]::Run()

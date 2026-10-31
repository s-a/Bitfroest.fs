#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <psapi.h>
#include <winternl.h>
#include <tlhelp32.h>
#include <objbase.h>
#include <shlobj.h>
#include <algorithm>
#include <charconv>
#include <cstdint>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <iterator>
#include <vector>
#include <exception>
#include <new>
#include <mutex>
#include <unordered_map>
#include "locks-win.h"
#include "windows-async-work.h"

namespace {
constexpr uint64_t kDotNetTicksAtUnixEpoch = 504911232000000000ULL;
constexpr ULONG kSystemExtendedHandleInformation = 64;
constexpr LONG kStatusInfoLengthMismatch = static_cast<LONG>(0xC0000004L);
constexpr DWORD kMaxSystemInformationBytes = 256U * 1024U * 1024U;
constexpr DWORD kMaxCommandLineBytes = 65536;

struct HandleTableEntry {
  PVOID object;
  ULONG_PTR process_id;
  ULONG_PTR handle_value;
  ULONG granted_access;
  USHORT creator_backtrace_index;
  USHORT object_type_index;
  ULONG handle_attributes;
  ULONG reserved;
};

struct HandleTableSnapshot {
  ULONG_PTR count;
  ULONG_PTR reserved;
  HandleTableEntry entries[1];
};

struct ProcessBasicInformationNative {
  PVOID reserved1;
  PVOID peb;
  PVOID reserved2[2];
  ULONG_PTR process_id;
  PVOID reserved3;
};

using NtQuerySystemInformationFn = NTSTATUS(NTAPI*)(ULONG, PVOID, ULONG, PULONG);
using NtQueryInformationProcessFn = NTSTATUS(NTAPI*)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG, PULONG);
using DbgUiConnectToDbgFn = NTSTATUS(NTAPI*)();
using DbgUiGetThreadDebugObjectFn = HANDLE(WINAPI*)();
using DbgUiSetThreadDebugObjectFn = VOID(WINAPI*)(HANDLE);
using RtlGetVersionFn = NTSTATUS(WINAPI*)(PRTL_OSVERSIONINFOW);
thread_local bool safe_debugger_ready = false;
thread_local HANDLE safe_debugger_object = nullptr;

#ifdef NATIVE_LOCKS_TESTING
std::atomic<unsigned int> trace_api{static_cast<unsigned int>(NativeLocksTraceApi::None)};
std::atomic<DWORD> trace_process_id{0};
std::atomic<uintptr_t> trace_handle{0};
std::atomic<bool> trace_active{false};
std::atomic<uint64_t> trace_sequence{0};
std::atomic<bool> force_stop_failure{false};
class TraceScope {
 public:
  TraceScope(NativeLocksTraceApi api, DWORD process_id, uintptr_t handle)
      : previous_api_(trace_api.load()), previous_process_id_(trace_process_id.load()),
        previous_handle_(trace_handle.load()), previous_active_(trace_active.load()),
        previous_sequence_(trace_sequence.load()), sequence_(trace_sequence.fetch_add(1) + 1) {
    trace_process_id.store(process_id);
    trace_handle.store(handle);
    trace_api.store(static_cast<unsigned int>(api));
    trace_active.store(true);
  }
  ~TraceScope() {
    if (trace_sequence.load() != sequence_) return;
    if (!previous_active_) {
      trace_active.store(false);
      return;
    }
    trace_process_id.store(previous_process_id_);
    trace_handle.store(previous_handle_);
    trace_api.store(previous_api_);
    trace_sequence.store(previous_sequence_);
    trace_active.store(true);
  }
 private:
  unsigned int previous_api_;
  DWORD previous_process_id_;
  uintptr_t previous_handle_;
  bool previous_active_;
  uint64_t previous_sequence_;
  uint64_t sequence_;
};
#define LOCKS_TRACE(api, pid, handle) TraceScope trace_scope(api, pid, handle)
#else
#define LOCKS_TRACE(api, pid, handle)
#endif

#ifdef NATIVE_LOCKS_TESTING
BOOL StopDebugging(DWORD process_id) {
  if (force_stop_failure.exchange(false)) {
    SetLastError(ERROR_ACCESS_DENIED);
    return FALSE;
  }
  return DebugActiveProcessStop(process_id);
}
#else
#define StopDebugging(process_id) DebugActiveProcessStop(process_id)
#endif

struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  Handle() = default;
  explicit Handle(HANDLE handle) : value(handle) {}
  ~Handle() { reset(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(other.value) { other.value = INVALID_HANDLE_VALUE; }
  Handle& operator=(Handle&& other) noexcept { if (this != &other) { reset(); value = other.value; other.value = INVALID_HANDLE_VALUE; } return *this; }
  void reset(HANDLE next = INVALID_HANDLE_VALUE) { if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value); value = next; }
  explicit operator bool() const { return value != INVALID_HANDLE_VALUE && value != nullptr; }
};

void CloseDebugEventHandles(const DEBUG_EVENT& event) {
  if (event.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT) {
    if (event.u.CreateProcessInfo.hFile) CloseHandle(event.u.CreateProcessInfo.hFile);
  } else if (event.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT) {
    if (event.u.LoadDll.hFile) CloseHandle(event.u.LoadDll.hFile);
  }
}

struct ProcessRef {
  DWORD id = 0;
  Handle handle;
  uint64_t creation_ticks = 0;
  std::wstring started;
  std::wstring executable;
  std::wstring command_line;
  std::wstring name;
};

uint64_t FileTimeValue(const FILETIME& value) {
  ULARGE_INTEGER combined{};
  combined.LowPart = value.dwLowDateTime;
  combined.HighPart = value.dwHighDateTime;
  return combined.QuadPart;
}

bool SupportedWindowsTenEleven() {
 #if !defined(_M_X64)
  return false;
 #else
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  auto get_version = reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion"));
  if (!get_version) return false;
  RTL_OSVERSIONINFOW version{};
  version.dwOSVersionInfoSize = sizeof(version);
  return get_version(&version) >= 0 && version.dwMajorVersion == 10 &&
      version.dwBuildNumber >= 10240 && version.dwBuildNumber <= 26300;
 #endif
}

bool NativeLocksSupportedInternal() {
  if (!SupportedWindowsTenEleven()) return false;
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  HMODULE kernel = GetModuleHandleW(L"kernel32.dll");
  constexpr const char* ntdll_exports[] = {
      "NtQuerySystemInformation", "NtQueryInformationProcess", "DbgUiConnectToDbg",
      "DbgUiGetThreadDebugObject", "DbgUiSetThreadDebugObject", "RtlGetVersion"};
  for (const char* name : ntdll_exports) if (!GetProcAddress(ntdll, name)) return false;
  return kernel && GetProcAddress(kernel, "IsProcessCritical") != nullptr;
}

bool Decimal(const std::wstring& text, uint64_t* value) {
  if (!value || text.empty() || text.size() > 20) return false;
  uint64_t parsed = 0;
  for (const wchar_t digit : text) {
    if (digit < L'0' || digit > L'9') return false;
    const uint64_t next = static_cast<uint64_t>(digit - L'0');
    if (parsed > (std::numeric_limits<uint64_t>::max() - next) / 10) return false;
    parsed = parsed * 10 + next;
  }
  *value = parsed;
  return true;
}

std::wstring DecimalText(uint64_t value) { return std::to_wstring(value); }

std::wstring FullPath(const std::wstring& input) {
  if (input.empty() || input.size() > 32767 || input.find(L'\0') != std::wstring::npos) return {};
  const bool drive = input.size() >= 3 && ((input[0] >= L'A' && input[0] <= L'Z') || (input[0] >= L'a' && input[0] <= L'z')) && input[1] == L':' && (input[2] == L'\\' || input[2] == L'/');
  const bool unc = input.size() > 4 && input[0] == L'\\' && input[1] == L'\\' && input[2] != L'.' && input[2] != L'?';
  if (!drive && !unc) return {};
  std::wstring normalized = input;
  std::replace(normalized.begin(), normalized.end(), L'/', L'\\');
  const DWORD needed = GetFullPathNameW(normalized.c_str(), 0, nullptr, nullptr);
  if (!needed || needed > 32767) return {};
  std::vector<wchar_t> buffer(needed);
  const DWORD written = GetFullPathNameW(normalized.c_str(), needed, buffer.data(), nullptr);
  if (!written || written >= needed) return {};
  normalized.assign(buffer.data(), written);
  const size_t root_length = normalized.size() >= 3 && normalized[1] == L':' ? 3 : 2;
  while (normalized.size() > root_length && normalized.back() == L'\\') normalized.pop_back();
  return normalized;
}

bool Inside(const std::wstring& value, const std::wstring& root) {
  const std::wstring path = FullPath(value);
  const std::wstring base = FullPath(root);
  if (path.empty() || base.empty()) return false;
  if (CompareStringOrdinal(path.c_str(), static_cast<int>(path.size()), base.c_str(), static_cast<int>(base.size()), TRUE) == CSTR_EQUAL) return true;
  return path.size() > base.size() && path[base.size()] == L'\\' &&
      CompareStringOrdinal(path.data(), static_cast<int>(base.size()), base.data(), static_cast<int>(base.size()), TRUE) == CSTR_EQUAL;
}

bool NoReparseAncestors(const std::wstring& path, DWORD* error) {
  size_t root_length = 0;
  if (path.size() >= 3 && path[1] == L':' && path[2] == L'\\') root_length = 3;
  else if (path.size() > 4 && path.rfind(L"\\\\", 0) == 0 && path[2] != L'.' && path[2] != L'?') {
    const size_t server_end = path.find(L'\\', 2);
    if (server_end == std::wstring::npos || server_end == 2) { if (error) *error = ERROR_INVALID_NAME; return false; }
    const size_t share_end = path.find(L'\\', server_end + 1);
    root_length = share_end == std::wstring::npos ? path.size() : share_end;
  } else { if (error) *error = ERROR_INVALID_NAME; return false; }
  std::wstring current = path.substr(0, root_length);
  const auto check = [&error](const std::wstring& value) {
    Handle handle(CreateFileW(value.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!handle) { if (error) *error = GetLastError(); return false; }
    FILE_ATTRIBUTE_TAG_INFO info{};
    if (!GetFileInformationByHandleEx(handle.value, FileAttributeTagInfo, &info, sizeof(info))) { if (error) *error = GetLastError(); return false; }
    if (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) { if (error) *error = ERROR_REPARSE_TAG_INVALID; return false; }
    return true;
  };
  if (!check(current)) return false;
  size_t start = root_length;
  while (start < path.size()) {
    while (start < path.size() && path[start] == L'\\') ++start;
    if (start >= path.size()) break;
    const size_t end = path.find(L'\\', start);
    current = path.substr(0, end == std::wstring::npos ? path.size() : end);
    if (!check(current)) return false;
    if (end == std::wstring::npos) break;
    start = end + 1;
  }
  return true;
}

bool DirectoryIsReal(const std::wstring& path, DWORD* error) {
  if (!NoReparseAncestors(path, error)) return false;
  Handle directory(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!directory) { if (error) *error = GetLastError(); return false; }
  FILE_ATTRIBUTE_TAG_INFO info{};
  if (!GetFileInformationByHandleEx(directory.value, FileAttributeTagInfo, &info, sizeof(info))) { if (error) *error = GetLastError(); return false; }
  if ((info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 || (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    if (error) *error = ERROR_REPARSE_TAG_INVALID;
    return false;
  }
  return true;
}

std::wstring FilePath(HANDLE handle, DWORD process_id = 0, uintptr_t source_handle = 0) {
#ifndef NATIVE_LOCKS_TESTING
  (void)process_id;
  (void)source_handle;
#endif
  if (GetFileType(handle) != FILE_TYPE_DISK) return {};
  std::vector<wchar_t> buffer(32768);
  DWORD size = 0;
  { LOCKS_TRACE(NativeLocksTraceApi::GetFinalPathNameByHandle, process_id, source_handle);
    size = GetFinalPathNameByHandleW(handle, buffer.data(), static_cast<DWORD>(buffer.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS); }
  if (!size || size >= buffer.size()) return {};
  std::wstring path(buffer.data(), size);
  if (path.rfind(L"\\\\?\\UNC\\", 0) == 0) path = L"\\\\" + path.substr(8);
  else if (path.rfind(L"\\\\?\\", 0) == 0) path.erase(0, 4);
  return FullPath(path);
}

BOOL ReadProcessMemoryTraced(HANDLE process, LPCVOID address, LPVOID buffer,
                             SIZE_T size, SIZE_T* read) {
  LOCKS_TRACE(NativeLocksTraceApi::ReadProcessMemory, GetProcessId(process), reinterpret_cast<uintptr_t>(process));
  return ReadProcessMemory(process, address, buffer, size, read);
}

NTSTATUS QueryProcessInformationTraced(NtQueryInformationProcessFn query, HANDLE process,
                                       PROCESSINFOCLASS information_class, PVOID buffer,
                                       ULONG size, PULONG returned) {
  LOCKS_TRACE(NativeLocksTraceApi::QueryInformationProcess, GetProcessId(process), reinterpret_cast<uintptr_t>(process));
  return query(process, information_class, buffer, size, returned);
}

std::wstring CommandLine(HANDLE process) {
  if (!SupportedWindowsTenEleven()) return {};
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  auto query = reinterpret_cast<NtQueryInformationProcessFn>(GetProcAddress(ntdll, "NtQueryInformationProcess"));
  if (!query) return {};
  BOOL wow64 = FALSE;
  BOOL wow64_ok = FALSE;
  { LOCKS_TRACE(NativeLocksTraceApi::IsWow64Process, GetProcessId(process), reinterpret_cast<uintptr_t>(process));
    wow64_ok = IsWow64Process(process, &wow64); }
  if (!wow64_ok) return {};
  if (wow64) {
    ULONG_PTR peb32 = 0;
    if (QueryProcessInformationTraced(query, process, static_cast<PROCESSINFOCLASS>(26), &peb32, sizeof(peb32), nullptr) < 0 || !peb32) return {};
    uint32_t parameters32 = 0;
    SIZE_T read32 = 0;
    if (!ReadProcessMemoryTraced(process, reinterpret_cast<const void*>(peb32 + 0x10U), &parameters32, sizeof(parameters32), &read32) || read32 != sizeof(parameters32) || !parameters32) return {};
    struct UnicodeString32 { USHORT length; USHORT maximum; uint32_t buffer; } command32{};
    if (!ReadProcessMemoryTraced(process, reinterpret_cast<const void*>(static_cast<uintptr_t>(parameters32) + 0x40U), &command32, sizeof(command32), &read32) || read32 != sizeof(command32) || !command32.buffer || command32.length > kMaxCommandLineBytes || (command32.length & 1U) != 0) return {};
    std::wstring value32(command32.length / sizeof(wchar_t), L'\0');
    if (command32.length && (!ReadProcessMemoryTraced(process, reinterpret_cast<const void*>(static_cast<uintptr_t>(command32.buffer)), value32.data(), command32.length, &read32) || read32 != command32.length)) return {};
    return value32;
  }
  ProcessBasicInformationNative basic{};
  if (QueryProcessInformationTraced(query, process, ProcessBasicInformation, &basic, sizeof(basic), nullptr) < 0 || !basic.peb) return {};
  ULONG_PTR parameters = 0;
  SIZE_T read = 0;
  const uintptr_t process_parameters_offset = sizeof(void*) == 8 ? 0x20U : 0x10U;
  if (!ReadProcessMemoryTraced(process, static_cast<const BYTE*>(basic.peb) + process_parameters_offset,
                               &parameters, sizeof(parameters), &read) || read != sizeof(parameters) || !parameters) return {};
  struct UnicodeStringNative { USHORT length; USHORT maximum; ULONG_PTR buffer; } command{};
  const uintptr_t command_line_offset = sizeof(void*) == 8 ? 0x70U : 0x40U;
  if (!ReadProcessMemoryTraced(process, reinterpret_cast<const BYTE*>(parameters) + command_line_offset,
                         &command, sizeof(command), &read) || read != sizeof(command) ||
      !command.buffer || command.length > kMaxCommandLineBytes || (command.length & 1U) != 0) return {};
  std::wstring value(command.length / sizeof(wchar_t), L'\0');
  if (command.length && (!ReadProcessMemoryTraced(process, reinterpret_cast<const void*>(command.buffer), value.data(), command.length, &read) || read != command.length)) return {};
  return value;
}

bool ProcessIdentity(DWORD pid, DWORD access, ProcessRef* process, DWORD* error) {
  if (!process || pid <= 4 || pid == GetCurrentProcessId()) { if (error) *error = ERROR_ACCESS_DENIED; return false; }
  HANDLE opened = nullptr;
  { LOCKS_TRACE(NativeLocksTraceApi::OpenProcess, pid, 0); opened = OpenProcess(access, FALSE, pid); }
  Handle handle(opened);
  if (!handle) { if (error) *error = GetLastError(); return false; }
  FILETIME created{}, exited{}, kernel{}, user{};
  BOOL times_ok = FALSE;
  { LOCKS_TRACE(NativeLocksTraceApi::GetProcessTimes, pid, reinterpret_cast<uintptr_t>(handle.value));
    times_ok = GetProcessTimes(handle.value, &created, &exited, &kernel, &user); }
  if (!times_ok) { if (error) *error = GetLastError(); return false; }
  const uint64_t created_value = FileTimeValue(created);
  std::vector<wchar_t> executable(32768);
  DWORD executable_size = static_cast<DWORD>(executable.size());
  BOOL image_ok = FALSE;
  { LOCKS_TRACE(NativeLocksTraceApi::QueryFullProcessImageName, pid, reinterpret_cast<uintptr_t>(handle.value));
    image_ok = QueryFullProcessImageNameW(handle.value, 0, executable.data(), &executable_size); }
  if (!image_ok) { if (error) *error = GetLastError(); return false; }
  process->id = pid;
  process->handle = std::move(handle);
  process->creation_ticks = created_value;
  process->started = DecimalText(created_value + kDotNetTicksAtUnixEpoch);
  process->executable.assign(executable.data(), executable_size);
  const size_t slash = process->executable.find_last_of(L"\\/");
  process->name = process->executable.substr(slash == std::wstring::npos ? 0 : slash + 1);
  process->command_line = CommandLine(process->handle.value);
  return true;
}

bool VerifyStarted(const NativeLockRow& row, HANDLE process, DWORD* error) {
  uint64_t expected = 0;
  if (!Decimal(row.started, &expected)) { if (error) *error = ERROR_INVALID_DATA; return false; }
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) { if (error) *error = GetLastError(); return false; }
  if (FileTimeValue(created) + kDotNetTicksAtUnixEpoch != expected) { if (error) *error = ERROR_RETRY; return false; }
  return true;
}

bool IsCritical(HANDLE process, DWORD* error) {
  using IsProcessCriticalFn = BOOL(WINAPI*)(HANDLE, PBOOL);
  HMODULE kernel = GetModuleHandleW(L"kernel32.dll");
  auto check = reinterpret_cast<IsProcessCriticalFn>(GetProcAddress(kernel, "IsProcessCritical"));
  BOOL critical = FALSE;
  if (!check || !check(process, &critical)) { if (error) *error = GetLastError() ? GetLastError() : ERROR_NOT_SUPPORTED; return true; }
  if (critical) { if (error) *error = ERROR_ACCESS_DENIED; return true; }
  return false;
}

bool ProtectedShellName(const std::wstring& name) {
  constexpr const wchar_t* names[] = {L"explorer.exe", L"winlogon.exe", L"csrss.exe", L"services.exe", L"lsass.exe", L"smss.exe", L"wininit.exe", L"dwm.exe"};
  return std::any_of(std::begin(names), std::end(names), [&name](const wchar_t* item) { return _wcsicmp(name.c_str(), item) == 0; });
}

bool HostAncestor(DWORD candidate) {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (!snapshot) return true;
  std::map<DWORD, DWORD> parents;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (!Process32FirstW(snapshot.value, &entry)) return true;
  do { parents[entry.th32ProcessID] = entry.th32ParentProcessID; } while (Process32NextW(snapshot.value, &entry));
  DWORD current = GetCurrentProcessId();
  std::set<DWORD> visited;
  for (size_t depth = 0; depth < 256 && current > 4 && visited.insert(current).second; ++depth) {
    const auto found = parents.find(current);
    if (found == parents.end()) return depth == 0;
    if (found->second <= 4) return 0;
    if (found->second == candidate) return true;
    current = found->second;
  }
  return false;
}

bool ValidateMutation(const NativeLocksRequest& request, const NativeLockRow& row,
                      ProcessRef* process, DWORD* error) {
  if (!DirectoryIsReal(FullPath(request.path), error) || !Inside(row.file, request.path)) { if (error && *error == ERROR_SUCCESS) *error = ERROR_ACCESS_DENIED; return false; }
  if (row.pid <= 4 || row.pid == GetCurrentProcessId() || request.host_pid != GetCurrentProcessId()) {
    if (error) *error = ERROR_ACCESS_DENIED;
    return false;
  }
  if (!ProcessIdentity(row.pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_DUP_HANDLE | PROCESS_VM_READ, process, error)) return false;
  if (!VerifyStarted(row, process->handle.value, error)) return false;
  if (HostAncestor(row.pid)) { if (error) *error = ERROR_INVALID_OWNER; return false; }
  if (ProtectedShellName(process->name)) { if (error) *error = ERROR_ACCESS_DENIED; return false; }
  if (IsCritical(process->handle.value, error)) { if (error && *error == ERROR_SUCCESS) *error = ERROR_ACCESS_DENIED; return false; }
  return true;
}

bool PrepareSafeDebugger(DWORD* error) {
  if (safe_debugger_ready) return true;
  if (!SupportedWindowsTenEleven()) { if (error) *error = ERROR_NOT_SUPPORTED; return false; }
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  auto get_version = reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion"));
  auto query_process = reinterpret_cast<NtQueryInformationProcessFn>(GetProcAddress(ntdll, "NtQueryInformationProcess"));
  auto connect_debugger = reinterpret_cast<DbgUiConnectToDbgFn>(GetProcAddress(ntdll, "DbgUiConnectToDbg"));
  auto get_thread_debug_object = reinterpret_cast<DbgUiGetThreadDebugObjectFn>(GetProcAddress(ntdll, "DbgUiGetThreadDebugObject"));
  auto set_thread_debug_object = reinterpret_cast<DbgUiSetThreadDebugObjectFn>(GetProcAddress(ntdll, "DbgUiSetThreadDebugObject"));
  if (!get_version || !query_process || !connect_debugger || !get_thread_debug_object || !set_thread_debug_object) { if (error) *error = ERROR_NOT_SUPPORTED; return false; }
  RTL_OSVERSIONINFOW version{};
  version.dwOSVersionInfoSize = sizeof(version);
  if (get_version(&version) < 0 || version.dwMajorVersion != 10 || version.dwBuildNumber < 10240) { if (error) *error = ERROR_NOT_SUPPORTED; return false; }
  if (get_thread_debug_object()) { if (error) *error = ERROR_BUSY; return false; }
  HANDLE existing_debug_object = nullptr;
  const NTSTATUS debug_status = query_process(GetCurrentProcess(), static_cast<PROCESSINFOCLASS>(30), &existing_debug_object, sizeof(existing_debug_object), nullptr);
  if (debug_status >= 0 && existing_debug_object) {
    CloseHandle(existing_debug_object);
    if (error) *error = ERROR_BUSY;
    return false;
  }
  if (debug_status != static_cast<NTSTATUS>(0xC0000353L)) { if (error) *error = ERROR_NOT_SUPPORTED; return false; }
  const NTSTATUS connected = connect_debugger();
  if (connected < 0) { if (error) *error = ERROR_NOT_SUPPORTED; return false; }
  const HANDLE debug_object = get_thread_debug_object();
  if (!debug_object) { if (error) *error = ERROR_NOT_SUPPORTED; return false; }
  if (!DebugSetProcessKillOnExit(FALSE)) {
    const DWORD failure = GetLastError() ? GetLastError() : ERROR_NOT_SUPPORTED;
    set_thread_debug_object(nullptr);
    CloseHandle(debug_object);
    if (error) *error = failure;
    return false;
  }
  safe_debugger_object = debug_object;
  safe_debugger_ready = true;
  return true;
}

bool ReleaseSafeDebugger(DWORD* error) {
  if (!safe_debugger_ready) return true;
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  auto set_thread_debug_object = reinterpret_cast<DbgUiSetThreadDebugObjectFn>(GetProcAddress(ntdll, "DbgUiSetThreadDebugObject"));
  if (!set_thread_debug_object || !safe_debugger_object) { if (error) *error = ERROR_NOT_SUPPORTED; return false; }
  set_thread_debug_object(nullptr);
  const HANDLE object = safe_debugger_object;
  safe_debugger_object = nullptr;
  safe_debugger_ready = false;
  if (!CloseHandle(object)) { if (error) *error = GetLastError(); return false; }
  return true;
}

bool NtHandles(std::vector<HandleTableEntry>* entries, USHORT* file_type, DWORD* error) {
  if (!entries || !file_type) { if (error) *error = ERROR_INVALID_PARAMETER; return false; }
  if (!SupportedWindowsTenEleven()) { if (error) *error = ERROR_NOT_SUPPORTED; return false; }
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  auto query = reinterpret_cast<NtQuerySystemInformationFn>(GetProcAddress(ntdll, "NtQuerySystemInformation"));
  if (!query) { if (error) *error = ERROR_PROC_NOT_FOUND; return false; }
  Handle sentinel(CreateFileW(L".", 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (!sentinel) { if (error) *error = GetLastError(); return false; }
  ULONG size = 1024U * 1024U;
  std::vector<BYTE> buffer;
  for (;;) {
    buffer.resize(size);
    ULONG needed = 0;
    NTSTATUS status = 0;
    { LOCKS_TRACE(NativeLocksTraceApi::NtQuerySystemInformation, 0, 0);
      status = query(kSystemExtendedHandleInformation, buffer.data(), size, &needed); }
    if (status >= 0) break;
    if (status != kStatusInfoLengthMismatch || size >= kMaxSystemInformationBytes) { if (error) *error = ERROR_NOT_SUPPORTED; return false; }
    const ULONG next = std::max(size * 2U, needed);
    if (next <= size || next > kMaxSystemInformationBytes) { if (error) *error = ERROR_NOT_ENOUGH_MEMORY; return false; }
    size = next;
  }
  if (buffer.size() < offsetof(HandleTableSnapshot, entries)) { if (error) *error = ERROR_INVALID_DATA; return false; }
  const auto* snapshot = reinterpret_cast<const HandleTableSnapshot*>(buffer.data());
  const size_t header_size = offsetof(HandleTableSnapshot, entries);
  if (snapshot->count > (buffer.size() - header_size) / sizeof(HandleTableEntry)) { if (error) *error = ERROR_INVALID_DATA; return false; }
  *file_type = 0;
  for (ULONG_PTR index = 0; index < snapshot->count; ++index) {
    const auto& entry = snapshot->entries[index];
    if (entry.process_id == GetCurrentProcessId() && entry.handle_value == reinterpret_cast<ULONG_PTR>(sentinel.value)) {
      *file_type = entry.object_type_index;
      break;
    }
  }
  if (!*file_type) { if (error) *error = ERROR_INVALID_DATA; return false; }
  entries->assign(snapshot->entries, snapshot->entries + snapshot->count);
  return true;
}

bool ProcessInfo(DWORD pid, std::map<DWORD, ProcessRef>* processes, std::set<DWORD>* denied) {
  auto found = processes->find(pid);
  if (found != processes->end()) return static_cast<bool>(found->second.handle);
  ProcessRef info;
  DWORD error = ERROR_SUCCESS;
  if (!ProcessIdentity(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_DUP_HANDLE | PROCESS_VM_READ, &info, &error)) {
    denied->insert(pid);
    processes->emplace(pid, ProcessRef{});
    return false;
  }
  processes->emplace(pid, std::move(info));
  return true;
}

NativeLockRow MakeRow(const ProcessRef& process, std::wstring file, const wchar_t* kind) {
  NativeLockRow row;
  row.pid = process.id;
  row.started = process.started;
  row.name = process.name;
  row.executable = process.executable;
  row.command_line = process.command_line;
  row.file = std::move(file);
  row.kind = kind;
  DWORD error = ERROR_SUCCESS;
  row.can_terminate = HostAncestor(process.id) == 0 && !ProtectedShellName(process.name) && !IsCritical(process.handle.value, &error);
  if (!row.can_terminate) row.termination_reason = L"ProtectedProcess";
  return row;
}

bool Scan(const NativeLocksRequest& request, const std::atomic<bool>& closed,
          NativeLocksResult* result, DWORD* error) {
  const std::wstring directory = FullPath(request.path);
  if (directory.empty() || !DirectoryIsReal(directory, error)) return false;
  std::vector<HandleTableEntry> handles;
  USHORT file_type = 0;
  if (!NtHandles(&handles, &file_type, error)) return false;
  std::map<DWORD, ProcessRef> processes;
  std::set<DWORD> denied;
  std::set<DWORD> observed;
  for (const auto& entry : handles) {
    if (closed.load()) { if (error) *error = ERROR_CANCELLED; return false; }
    if (entry.object_type_index != file_type || entry.process_id <= 4 || entry.process_id > MAXDWORD || entry.process_id == GetCurrentProcessId()) continue;
    const DWORD pid = static_cast<DWORD>(entry.process_id);
    if (!ProcessInfo(pid, &processes, &denied)) continue;
    HANDLE duplicate = nullptr;
    if (!DuplicateHandle(processes[pid].handle.value, reinterpret_cast<HANDLE>(entry.handle_value), GetCurrentProcess(), &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS)) { denied.insert(pid); continue; }
    Handle copy(duplicate);
    const std::wstring file = FilePath(copy.value, pid, entry.handle_value);
    if (file.empty()) { if (GetFileType(copy.value) == FILE_TYPE_DISK) denied.insert(pid); continue; }
    if (!Inside(file, directory)) continue;
    NativeLockRow row = MakeRow(processes[pid], file, L"handle");
    row.handle = DecimalText(entry.handle_value);
    result->rows.push_back(std::move(row));
    observed.insert(pid);
  }

  std::vector<DWORD> pids(4096);
  DWORD bytes = 0;
  for (;;) {
    if (!EnumProcesses(pids.data(), static_cast<DWORD>(pids.size() * sizeof(DWORD)), &bytes)) { if (error) *error = GetLastError(); return false; }
    if (bytes < pids.size() * sizeof(DWORD)) break;
    if (pids.size() >= 1048576) { if (error) *error = ERROR_NOT_ENOUGH_MEMORY; return false; }
    pids.resize(pids.size() * 2);
  }
  for (size_t index = 0; index < bytes / sizeof(DWORD); ++index) {
    if (closed.load()) { if (error) *error = ERROR_CANCELLED; return false; }
    const DWORD pid = pids[index];
    if (pid <= 4 || pid == GetCurrentProcessId()) continue;
    ProcessRef process;
    DWORD process_error = ERROR_SUCCESS;
    if (!ProcessIdentity(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, &process, &process_error)) { denied.insert(pid); continue; }
    HMODULE modules[2048]{};
    DWORD module_bytes = 0;
    BOOL modules_ok = FALSE;
    { LOCKS_TRACE(NativeLocksTraceApi::EnumProcessModules, pid, reinterpret_cast<uintptr_t>(process.handle.value));
      modules_ok = EnumProcessModules(process.handle.value, modules, sizeof(modules), &module_bytes); }
    if (!modules_ok) { denied.insert(pid); continue; }
    const DWORD count = std::min<DWORD>(module_bytes / sizeof(HMODULE), static_cast<DWORD>(std::size(modules)));
    bool found_path = false;
    for (DWORD module_index = 0; module_index < count; ++module_index) {
      std::vector<wchar_t> module_path(32768);
      DWORD path_size = 0;
      { LOCKS_TRACE(NativeLocksTraceApi::GetModuleFileNameEx, pid, reinterpret_cast<uintptr_t>(process.handle.value));
        path_size = GetModuleFileNameExW(process.handle.value, modules[module_index], module_path.data(), static_cast<DWORD>(module_path.size())); }
      if (!path_size || path_size >= module_path.size()) { denied.insert(pid); continue; }
      std::wstring file(module_path.data(), path_size);
      if (!Inside(file, directory)) continue;
      NativeLockRow row = MakeRow(process, FullPath(file), CompareStringOrdinal(file.c_str(), static_cast<int>(file.size()), process.executable.c_str(), static_cast<int>(process.executable.size()), TRUE) == CSTR_EQUAL ? L"image" : L"module");
      row.module = DecimalText(reinterpret_cast<uintptr_t>(modules[module_index]));
      result->rows.push_back(std::move(row));
      found_path = true;
    }
    if (found_path) observed.insert(pid);
  }
  result->inaccessible = static_cast<uint32_t>(denied.size());
  return true;
}

bool GetFileIdentity(const std::wstring& path, uint64_t* volume, uint64_t* index, DWORD* error) {
  Handle file(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (!file) { if (error) *error = GetLastError(); return false; }
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(file.value, &info)) { if (error) *error = GetLastError(); return false; }
  if (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) { if (error) *error = ERROR_REPARSE_TAG_INVALID; return false; }
  if (volume) *volume = info.dwVolumeSerialNumber;
  if (index) *index = (static_cast<uint64_t>(info.nFileIndexHigh) << 32) | info.nFileIndexLow;
  return true;
}

std::wstring Parent(const std::wstring& path) {
  const size_t separator = path.find_last_of(L"\\/");
  return separator == std::wstring::npos ? std::wstring{} : path.substr(0, separator);
}

bool Rename(const NativeLocksRequest& request, const std::atomic<bool>& closed,
            NativeLocksResult* result, DWORD* error) {
  const std::wstring source = FullPath(request.path);
  const std::wstring destination = FullPath(request.destination);
  if (source.empty() || destination.empty() || Inside(destination, source) || Inside(source, destination)) { if (error) *error = ERROR_INVALID_PARAMETER; return false; }
  if (!DirectoryIsReal(Parent(source), error)) return false;
  uint64_t volume = 0, index = 0, parent_volume = 0, parent_index = 0;
  if (!GetFileIdentity(source, &volume, &index, error) ||
      !GetFileIdentity(Parent(destination), &parent_volume, &parent_index, error)) return false;
  uint64_t expected_volume = 0, expected_index = 0, expected_parent_volume = 0, expected_parent_index = 0;
  if (!Decimal(request.expected_dev, &expected_volume) || !Decimal(request.expected_ino, &expected_index) ||
      !Decimal(request.expected_parent_dev, &expected_parent_volume) || !Decimal(request.expected_parent_ino, &expected_parent_index) ||
      volume != expected_volume || index != expected_index || parent_volume != expected_parent_volume || parent_index != expected_parent_index) {
    if (error) *error = ERROR_RETRY;
    return false;
  }
  if (!DirectoryIsReal(Parent(destination), error)) return false;
  if (closed.load()) { if (error) *error = ERROR_CANCELLED; return false; }
  if (!MoveFileExW(source.c_str(), destination.c_str(), 0)) { if (error) *error = GetLastError(); return false; }
  result->changed = 1;
  return true;
}

bool Terminate(const NativeLocksRequest& request, const std::atomic<bool>& closed,
               NativeLocksResult* result) {
  std::set<DWORD> killed;
  for (const auto& row : request.rows) {
    DWORD error = ERROR_SUCCESS;
    ProcessRef process;
    if (!ValidateMutation(request, row, &process, &error)) { result->errors.push_back(L"PID " + std::to_wstring(row.pid) + L": " + std::to_wstring(error)); continue; }
    if (killed.find(row.pid) != killed.end()) continue;
    if (closed.load()) { result->errors.push_back(L"Die Sitzung wurde geschlossen."); break; }
    Handle victim(OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, row.pid));
    if (!victim || !VerifyStarted(row, victim.value, &error)) { result->errors.push_back(L"PID " + std::to_wstring(row.pid) + L": " + std::to_wstring(victim ? error : GetLastError())); continue; }
    if (closed.load()) { result->errors.push_back(L"Die Sitzung wurde geschlossen."); break; }
    if (!TerminateProcess(victim.value, ERROR_PROCESS_ABORTED)) { result->errors.push_back(L"PID " + std::to_wstring(row.pid) + L": " + std::to_wstring(GetLastError())); continue; }
    const DWORD wait = WaitForSingleObject(victim.value, 5000);
    if (wait != WAIT_OBJECT_0) { result->errors.push_back(L"PID " + std::to_wstring(row.pid) + L": " + std::to_wstring(wait == WAIT_FAILED ? GetLastError() : ERROR_TIMEOUT)); continue; }
    killed.insert(row.pid);
    ++result->changed;
  }
  return true;
}

bool ReleaseHandle(const NativeLocksRequest& request, const NativeLockRow& row,
                   const std::atomic<bool>& closed, DWORD* error) {
  ProcessRef process;
  bool valid = false;
  { LOCKS_TRACE(NativeLocksTraceApi::ValidateMutation, row.pid, 0);
    valid = ValidateMutation(request, row, &process, error); }
  if (!valid) return false;
  uint64_t handle_value = 0;
  if (!Decimal(row.handle, &handle_value)) { if (error) *error = ERROR_INVALID_DATA; return false; }
  if (closed.load()) { if (error) *error = ERROR_CANCELLED; return false; }
  bool debugger_ready = false;
  { LOCKS_TRACE(NativeLocksTraceApi::PrepareSafeDebugger, row.pid, 0); debugger_ready = PrepareSafeDebugger(error); }
  if (!debugger_ready) return false;
  if (closed.load()) {
    if (error) *error = ERROR_CANCELLED;
    LOCKS_TRACE(NativeLocksTraceApi::ReleaseSafeDebugger, row.pid, 0);
    ReleaseSafeDebugger(nullptr);
    return false;
  }
  BOOL attached_ok = FALSE;
  { LOCKS_TRACE(NativeLocksTraceApi::DebugActiveProcess, row.pid, 0); attached_ok = DebugActiveProcess(row.pid); }
  if (!attached_ok) {
    const DWORD failure = GetLastError();
    { LOCKS_TRACE(NativeLocksTraceApi::ReleaseSafeDebugger, row.pid, 0); ReleaseSafeDebugger(nullptr); }
    if (error) *error = failure;
    return false;
  }
  bool attached = true;
  const auto detach = [&]() {
    if (attached) {
      BOOL stopped = FALSE;
      { LOCKS_TRACE(NativeLocksTraceApi::DebugActiveProcessStop, row.pid, 0); stopped = StopDebugging(row.pid); }
      if (!stopped) {
        const DWORD stop_error = GetLastError();
        { LOCKS_TRACE(NativeLocksTraceApi::ReleaseSafeDebugger, row.pid, 0); ReleaseSafeDebugger(nullptr); }
        if (error) *error = stop_error;
        return false;
      }
    }
    attached = false;
    bool released = false;
    { LOCKS_TRACE(NativeLocksTraceApi::ReleaseSafeDebugger, row.pid, 0); released = ReleaseSafeDebugger(error); }
    return released;
  };
  DEBUG_EVENT event{};
  BOOL event_ready = FALSE;
  { LOCKS_TRACE(NativeLocksTraceApi::WaitForDebugEvent, row.pid, 0); event_ready = WaitForDebugEvent(&event, 3000); }
  if (!event_ready) { if (error) *error = GetLastError(); detach(); return false; }
  if (event.dwProcessId != row.pid || event.dwDebugEventCode != CREATE_PROCESS_DEBUG_EVENT) {
    { LOCKS_TRACE(NativeLocksTraceApi::CloseDebugEventHandles, event.dwProcessId, event.dwThreadId);
      CloseDebugEventHandles(event); }
    BOOL continued = FALSE;
    { LOCKS_TRACE(NativeLocksTraceApi::ContinueDebugEvent, event.dwProcessId, event.dwThreadId);
      continued = ContinueDebugEvent(event.dwProcessId, event.dwThreadId, DBG_CONTINUE); }
    (void)continued;
    if (error) *error = ERROR_INVALID_DATA;
    detach();
    return false;
  }
  { LOCKS_TRACE(NativeLocksTraceApi::CloseDebugEventHandles, event.dwProcessId, event.dwThreadId);
    CloseDebugEventHandles(event); }
  Handle copy;
  BOOL duplicated = FALSE;
  { LOCKS_TRACE(NativeLocksTraceApi::DuplicateValidate, row.pid, static_cast<uintptr_t>(handle_value));
    duplicated = DuplicateHandle(process.handle.value, reinterpret_cast<HANDLE>(static_cast<uintptr_t>(handle_value)), GetCurrentProcess(), &copy.value, 0, FALSE, DUPLICATE_SAME_ACCESS); }
  if (!duplicated) {
    if (error) *error = GetLastError();
    { LOCKS_TRACE(NativeLocksTraceApi::ContinueDebugEvent, event.dwProcessId, event.dwThreadId);
      ContinueDebugEvent(event.dwProcessId, event.dwThreadId, DBG_CONTINUE); }
    detach();
    return false;
  }
  const std::wstring actual = FilePath(copy.value, row.pid, static_cast<uintptr_t>(handle_value));
  if (actual.empty() || CompareStringOrdinal(actual.c_str(), static_cast<int>(actual.size()), row.file.c_str(), static_cast<int>(row.file.size()), TRUE) != CSTR_EQUAL) {
    if (error) *error = ERROR_RETRY;
    { LOCKS_TRACE(NativeLocksTraceApi::ContinueDebugEvent, event.dwProcessId, event.dwThreadId);
      ContinueDebugEvent(event.dwProcessId, event.dwThreadId, DBG_CONTINUE); }
    detach();
    return false;
  }
  if (closed.load()) {
    if (error) *error = ERROR_CANCELLED;
    { LOCKS_TRACE(NativeLocksTraceApi::ContinueDebugEvent, event.dwProcessId, event.dwThreadId);
      ContinueDebugEvent(event.dwProcessId, event.dwThreadId, DBG_CONTINUE); }
    detach();
    return false;
  }
  HANDLE closed_copy = nullptr;
  BOOL closed_source = FALSE;
  { LOCKS_TRACE(NativeLocksTraceApi::DuplicateCloseSource, row.pid, static_cast<uintptr_t>(handle_value));
    closed_source = DuplicateHandle(process.handle.value, reinterpret_cast<HANDLE>(static_cast<uintptr_t>(handle_value)), GetCurrentProcess(), &closed_copy, 0, FALSE, DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS); }
  const DWORD close_error = closed_source ? ERROR_SUCCESS : GetLastError();
  if (closed_copy) CloseHandle(closed_copy);
  BOOL continued = FALSE;
  { LOCKS_TRACE(NativeLocksTraceApi::ContinueDebugEvent, event.dwProcessId, event.dwThreadId);
    continued = ContinueDebugEvent(event.dwProcessId, event.dwThreadId, DBG_CONTINUE); }
  const DWORD continue_error = continued ? ERROR_SUCCESS : GetLastError();
  const bool detached = detach();
  if (!closed_source) { if (error) *error = close_error; return false; }
  if (!continued || !detached) { if (error && *error == ERROR_SUCCESS) *error = continue_error ? continue_error : ERROR_GEN_FAILURE; return false; }
  return true;
}

bool UnloadModule(const NativeLocksRequest& request, const NativeLockRow& row,
                  const std::atomic<bool>& closed, DWORD* error) {
  if (row.file.size() < 4 || _wcsicmp(row.file.c_str() + row.file.size() - 4, L".dll") != 0) { if (error) *error = ERROR_NOT_SUPPORTED; return false; }
  ProcessRef process;
  if (!ValidateMutation(request, row, &process, error)) return false;
  BOOL wow64 = FALSE;
  if (!IsWow64Process(process.handle.value, &wow64) || wow64) { if (error) *error = GetLastError() ? GetLastError() : ERROR_NOT_SUPPORTED; return false; }
  uint64_t base_value = 0;
  if (!Decimal(row.module, &base_value)) { if (error) *error = ERROR_INVALID_DATA; return false; }
  HMODULE modules[2048]{};
  DWORD module_bytes = 0;
  if (!EnumProcessModules(process.handle.value, modules, sizeof(modules), &module_bytes)) { if (error) *error = GetLastError(); return false; }
  bool found = false;
  HMODULE local_modules[2048]{};
  DWORD local_module_bytes = 0;
  if (!EnumProcessModules(GetCurrentProcess(), local_modules, sizeof(local_modules), &local_module_bytes)) { if (error) *error = GetLastError(); return false; }
  std::wstring owner_path;
  uintptr_t function_address = 0;
  const uintptr_t local_count = std::min<DWORD>(local_module_bytes / sizeof(HMODULE), static_cast<DWORD>(std::size(local_modules)));
  for (DWORD index = 0; index < local_count; ++index) {
    MODULEINFO info{};
    if (!GetModuleInformation(GetCurrentProcess(), local_modules[index], &info, sizeof(info))) continue;
    const uintptr_t base = reinterpret_cast<uintptr_t>(info.lpBaseOfDll);
    const uintptr_t address = reinterpret_cast<uintptr_t>(GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "FreeLibrary"));
    if (address < base || address >= base + info.SizeOfImage) continue;
    std::vector<wchar_t> path(32768);
    const DWORD length = GetModuleFileNameExW(GetCurrentProcess(), local_modules[index], path.data(), static_cast<DWORD>(path.size()));
    if (!length || length >= path.size()) continue;
    owner_path.assign(path.data(), length);
    function_address = address;
    break;
  }
  if (owner_path.empty()) { if (error) *error = ERROR_PROC_NOT_FOUND; return false; }
  uintptr_t remote_function = 0;
  const DWORD count = std::min<DWORD>(module_bytes / sizeof(HMODULE), static_cast<DWORD>(std::size(modules)));
  for (DWORD index = 0; index < count; ++index) {
    std::vector<wchar_t> path(32768);
    const DWORD length = GetModuleFileNameExW(process.handle.value, modules[index], path.data(), static_cast<DWORD>(path.size()));
    if (!length || length >= path.size()) continue;
    const std::wstring module_path(path.data(), length);
    if (reinterpret_cast<uintptr_t>(modules[index]) == base_value && CompareStringOrdinal(module_path.c_str(), static_cast<int>(module_path.size()), row.file.c_str(), static_cast<int>(row.file.size()), TRUE) == CSTR_EQUAL) found = true;
    if (CompareStringOrdinal(module_path.c_str(), static_cast<int>(module_path.size()), owner_path.c_str(), static_cast<int>(owner_path.size()), TRUE) == CSTR_EQUAL) {
      MODULEINFO remote_info{};
      if (GetModuleInformation(process.handle.value, modules[index], &remote_info, sizeof(remote_info))) {
        MODULEINFO local_info{};
        for (DWORD local_index = 0; local_index < local_count; ++local_index) {
          if (GetModuleInformation(GetCurrentProcess(), local_modules[local_index], &local_info, sizeof(local_info))) {
            std::vector<wchar_t> local_path(32768);
            const DWORD local_length = GetModuleFileNameExW(GetCurrentProcess(), local_modules[local_index], local_path.data(), static_cast<DWORD>(local_path.size()));
            if (local_length && local_length < local_path.size() && CompareStringOrdinal(local_path.data(), static_cast<int>(local_length), owner_path.c_str(), static_cast<int>(owner_path.size()), TRUE) == CSTR_EQUAL) {
              if (local_info.SizeOfImage == remote_info.SizeOfImage) remote_function = reinterpret_cast<uintptr_t>(remote_info.lpBaseOfDll) + (function_address - reinterpret_cast<uintptr_t>(local_info.lpBaseOfDll));
              break;
            }
          }
        }
      }
    }
  }
  if (!found || !remote_function) { if (error) *error = ERROR_RETRY; return false; }
  Handle remote(OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE | SYNCHRONIZE, FALSE, row.pid));
  if (!remote) { if (error) *error = GetLastError(); return false; }
  if (closed.load()) { if (error) *error = ERROR_CANCELLED; return false; }
  Handle thread(CreateRemoteThread(remote.value, nullptr, 0,
      reinterpret_cast<LPTHREAD_START_ROUTINE>(remote_function),
      reinterpret_cast<void*>(static_cast<uintptr_t>(base_value)), 0, nullptr));
  if (!thread) { if (error) *error = GetLastError(); return false; }
  const DWORD wait = WaitForSingleObject(thread.value, 5000);
  if (wait != WAIT_OBJECT_0) { if (error) *error = wait == WAIT_FAILED ? GetLastError() : ERROR_TIMEOUT; return false; }
  DWORD code = 0;
  if (!GetExitCodeThread(thread.value, &code) || code == 0) { if (error) *error = GetLastError() ? GetLastError() : ERROR_GEN_FAILURE; return false; }
  return true;
}

bool MutateRows(const std::string& operation, const NativeLocksRequest& request,
                const std::atomic<bool>& closed, NativeLocksResult* result) {
  for (const auto& row : request.rows) {
    if (closed.load()) { result->errors.push_back(L"Die Sitzung wurde geschlossen."); break; }
    DWORD error = ERROR_SUCCESS;
    bool success = false;
    if (operation == "locks.releaseHandles") {
      if (row.kind == L"image") error = ERROR_ACCESS_DENIED;
      else if (row.kind != L"handle") error = ERROR_INVALID_DATA;
      else success = ReleaseHandle(request, row, closed, &error);
    } else if (operation == "locks.unloadModules") {
      if (row.kind != L"module") error = ERROR_INVALID_DATA;
      else success = UnloadModule(request, row, closed, &error);
    } else return false;
    if (success) ++result->changed;
    else result->errors.push_back(L"PID " + std::to_wstring(row.pid) + L": " + std::to_wstring(error));
  }
  return true;
}

class WindowsPendingRenameStore final : public PendingRenameStore {
 public:
  bool Read(std::vector<uint8_t>* bytes, bool* exists, DWORD* error) override {
    constexpr wchar_t key[] = L"SYSTEM\\CurrentControlSet\\Control\\Session Manager";
    DWORD size = 0, type = 0;
    LSTATUS status = RegGetValueW(HKEY_LOCAL_MACHINE, key, L"PendingFileRenameOperations", RRF_RT_REG_MULTI_SZ, &type, nullptr, &size);
    if (status == ERROR_FILE_NOT_FOUND) { *exists = false; bytes->clear(); return true; }
    if (status != ERROR_SUCCESS || type != REG_MULTI_SZ || size > 16U * 1024U * 1024U) { if (error) *error = status == ERROR_SUCCESS ? ERROR_INVALID_DATA : static_cast<DWORD>(status); return false; }
    bytes->resize(size);
    status = RegGetValueW(HKEY_LOCAL_MACHINE, key, L"PendingFileRenameOperations", RRF_RT_REG_MULTI_SZ, &type, bytes->data(), &size);
    if (status != ERROR_SUCCESS || type != REG_MULTI_SZ || size > bytes->size()) { if (error) *error = static_cast<DWORD>(status ? status : ERROR_INVALID_DATA); return false; }
    bytes->resize(size);
    *exists = true;
    return true;
  }
  bool QueueDelete(const std::wstring& path, DWORD* error) override {
    if (path.empty() || !MoveFileExW(path.c_str(), nullptr, MOVEFILE_DELAY_UNTIL_REBOOT)) {
      if (error) *error = path.empty() ? ERROR_INVALID_PARAMETER : GetLastError();
      return false;
    }
    return true;
  }
};

bool CollectRestartFiles(const std::wstring& directory, std::vector<std::wstring>* files, DWORD* error) {
  if (!DirectoryIsReal(directory, error)) return false;
  WIN32_FIND_DATAW data{};
  HANDLE find = FindFirstFileW((directory + L"\\*").c_str(), &data);
  if (find == INVALID_HANDLE_VALUE) { if (error) *error = GetLastError(); return false; }
  bool success = true;
  do {
    if (wcscmp(data.cFileName, L".") == 0 || wcscmp(data.cFileName, L"..") == 0) continue;
    const std::wstring child = directory + L"\\" + data.cFileName;
    const DWORD attributes = GetFileAttributesW(child.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) { if (error) *error = attributes == INVALID_FILE_ATTRIBUTES ? GetLastError() : ERROR_REPARSE_TAG_INVALID; success = false; break; }
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) && !CollectRestartFiles(child, files, error)) { success = false; break; }
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) files->push_back(child);
  } while (FindNextFileW(find, &data));
  const DWORD find_error = GetLastError();
  FindClose(find);
  if (success && find_error != ERROR_NO_MORE_FILES) { if (error) *error = find_error; success = false; }
  if (success) files->push_back(directory);
  return success;
}

bool DecodePending(const std::vector<uint8_t>& bytes, bool exists, std::vector<std::wstring>* values, DWORD* error) {
  values->clear();
  if (!exists) return true;
  if (bytes.size() < sizeof(wchar_t) * 2 || bytes.size() % sizeof(wchar_t) != 0) { if (error) *error = ERROR_INVALID_DATA; return false; }
  const auto* data = reinterpret_cast<const wchar_t*>(bytes.data());
  const size_t count = bytes.size() / sizeof(wchar_t);
  if (data[count - 1] != L'\0' || data[count - 2] != L'\0') { if (error) *error = ERROR_INVALID_DATA; return false; }
  size_t start = 0;
  while (start < count - 1 && data[start]) {
    size_t first_end = start;
    while (first_end < count && data[first_end]) ++first_end;
    if (first_end == count) { if (error) *error = ERROR_INVALID_DATA; return false; }
    values->emplace_back(data + start, first_end - start);
    start = first_end + 1;
    size_t second_end = start;
    while (second_end < count && data[second_end]) ++second_end;
    if (second_end == count) { if (error) *error = ERROR_INVALID_DATA; return false; }
    values->emplace_back(data + start, second_end - start);
    start = second_end + 1;
  }
  return true;
}

std::vector<uint8_t> EncodePending(const std::vector<std::wstring>& values) {
  size_t size = values.empty() ? 2 : 1;
  for (const auto& value : values) size += value.size() + 1;
  std::vector<uint8_t> bytes(size * sizeof(wchar_t));
  auto* data = reinterpret_cast<wchar_t*>(bytes.data());
  size_t offset = 0;
  for (const auto& value : values) { std::copy(value.begin(), value.end(), data + offset); offset += value.size(); data[offset++] = L'\0'; }
  data[offset] = L'\0';
  return bytes;
}

std::wstring RestartSource(const std::wstring& path) { return path.rfind(L"\\\\", 0) == 0 ? L"\\??\\UNC\\" + path.substr(2) : L"\\??\\" + path; }

std::wstring ExtendedWinPath(const std::wstring& path) {
  if (path.size() < MAX_PATH || path.rfind(L"\\\\?\\", 0) == 0) return path;
  if (path.size() >= 3 && path[1] == L':' && path[2] == L'\\') return L"\\\\?\\" + path;
  if (path.rfind(L"\\\\", 0) == 0) return L"\\\\?\\UNC\\" + path.substr(2);
  return path;
}

bool EnsureDirectoryTree(const std::wstring& path, DWORD* error) {
  const std::wstring full = FullPath(path);
  if (full.empty()) { if (error) *error = ERROR_INVALID_NAME; return false; }
  size_t root_length = 0;
  if (full.size() >= 3 && full[1] == L':' && full[2] == L'\\') root_length = 3;
  else if (full.rfind(L"\\\\", 0) == 0 && full.size() > 4 && full[2] != L'.' && full[2] != L'?') {
    const size_t server_end = full.find(L'\\', 2);
    if (server_end == std::wstring::npos || server_end == 2) { if (error) *error = ERROR_INVALID_NAME; return false; }
    const size_t share_end = full.find(L'\\', server_end + 1);
    root_length = share_end == std::wstring::npos ? full.size() : share_end;
  } else { if (error) *error = ERROR_INVALID_NAME; return false; }
  std::wstring current = full.substr(0, root_length);
  const auto ensure_component = [&error](const std::wstring& component) {
    const std::wstring api_component = ExtendedWinPath(component);
    DWORD attributes = GetFileAttributesW(api_component.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
      const DWORD query_error = GetLastError();
      if (query_error != ERROR_FILE_NOT_FOUND && query_error != ERROR_PATH_NOT_FOUND) { if (error) *error = query_error; return false; }
      if (!CreateDirectoryW(api_component.c_str(), nullptr)) {
        const DWORD create_error = GetLastError();
        if (create_error != ERROR_ALREADY_EXISTS) { if (error) *error = create_error; return false; }
      }
      attributes = GetFileAttributesW(api_component.c_str());
      if (attributes == INVALID_FILE_ATTRIBUTES) { if (error) *error = GetLastError(); return false; }
    }
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) { if (error) *error = ERROR_DIRECTORY; return false; }
    if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) { if (error) *error = ERROR_REPARSE_TAG_INVALID; return false; }
    return true;
  };
  if (!ensure_component(current)) return false;
  size_t offset = root_length;
  while (offset < full.size()) {
    while (offset < full.size() && full[offset] == L'\\') ++offset;
    if (offset == full.size()) break;
    const size_t end = full.find(L'\\', offset);
    const size_t length = end == std::wstring::npos ? full.size() - offset : end - offset;
    if (!current.empty() && current.back() != L'\\') current.push_back(L'\\');
    current.append(full, offset, length);
    if (!ensure_component(current)) return false;
    offset += length;
  }
  return true;
}

bool WriteRegistryBackup(const std::wstring& backup, const std::vector<uint8_t>& bytes, bool exists,
                         std::vector<uint8_t>* expected_content, DWORD* error) {
  const std::wstring parent = Parent(backup);
  if (!EnsureDirectoryTree(parent, error)) return false;
  std::wstring body = L"Windows Registry Editor Version 5.00\r\n\r\n[HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager]\r\n";
  if (!exists) body += L"\"PendingFileRenameOperations\"=-\r\n";
  else {
    static constexpr wchar_t digits[] = L"0123456789abcdef";
    body += L"\"PendingFileRenameOperations\"=hex(7):";
    for (size_t index = 0; index < bytes.size(); ++index) {
      if (index) body += index % 16 == 0 ? L",\r\n  " : L",";
      body.push_back(digits[bytes[index] >> 4]); body.push_back(digits[bytes[index] & 0x0f]);
    }
    body += L"\r\n";
  }
  std::vector<uint8_t> content(sizeof(wchar_t) * (body.size() + 1));
  content[0] = 0xff; content[1] = 0xfe;
  if (!body.empty()) memcpy(content.data() + sizeof(wchar_t), body.data(), body.size() * sizeof(wchar_t));
  const std::wstring backup_api_path = ExtendedWinPath(backup);
  Handle file(CreateFileW(backup_api_path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!file) { if (error) *error = GetLastError(); return false; }
  DWORD written = 0;
  if (!WriteFile(file.value, content.data(), static_cast<DWORD>(content.size()), &written, nullptr) || written != content.size() || !FlushFileBuffers(file.value)) { if (error) *error = GetLastError() ? GetLastError() : ERROR_WRITE_FAULT; return false; }
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file.value, &size) || size.QuadPart != static_cast<LONGLONG>(content.size())) { if (error) *error = ERROR_WRITE_FAULT; return false; }
  if (expected_content) *expected_content = std::move(content);
  return true;
}

bool ReadRegistryBackup(const std::wstring& backup, std::vector<uint8_t>* bytes, DWORD* error) {
  if (!bytes) { if (error) *error = ERROR_INVALID_PARAMETER; return false; }
  const std::wstring backup_api_path = ExtendedWinPath(backup);
  Handle file(CreateFileW(backup_api_path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                         FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!file) { if (error) *error = GetLastError(); return false; }
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  if (!GetFileInformationByHandleEx(file.value, FileAttributeTagInfo, &attributes, sizeof(attributes))) {
    if (error) *error = GetLastError();
    return false;
  }
  if ((attributes.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    if (error) *error = ERROR_INVALID_DATA;
    return false;
  }
  LARGE_INTEGER size{};
  constexpr LONGLONG max_backup_size = 64LL * 1024LL * 1024LL;
  if (!GetFileSizeEx(file.value, &size) || size.QuadPart < 0 || size.QuadPart > max_backup_size) {
    if (error) *error = GetLastError() ? GetLastError() : ERROR_FILE_TOO_LARGE;
    return false;
  }
  bytes->resize(static_cast<size_t>(size.QuadPart));
  DWORD read = 0;
  if (size.QuadPart != 0 && (!ReadFile(file.value, bytes->data(), static_cast<DWORD>(size.QuadPart), &read, nullptr) || read != static_cast<DWORD>(size.QuadPart))) {
    if (error) *error = GetLastError() ? GetLastError() : ERROR_READ_FAULT;
    return false;
  }
  return true;
}

}

bool NativeLocksSupported() {
  return NativeLocksSupportedInternal();
}

#ifdef NATIVE_LOCKS_TESTING
NativeLocksTraceState GetNativeLocksTraceState() {
  NativeLocksTraceState state;
  state.api = static_cast<NativeLocksTraceApi>(trace_api.load());
  state.process_id = trace_process_id.load();
  state.handle = trace_handle.load();
  state.active = trace_active.load();
  return state;
}
#endif

static bool ResolveNativeLocksImpl(const std::string& operation, const NativeLocksRequest& request,
                                   const std::atomic<bool>& closed, NativeLocksResult* result,
                                   DWORD* native_error, NativeLocksSessionState* session_state,
                                   PendingRenameStore* injected_store) {
  if (native_error) *native_error = ERROR_SUCCESS;
  if (!result || closed.load()) { if (native_error) *native_error = ERROR_CANCELLED; return false; }
  DWORD error = ERROR_SUCCESS;
  bool success = false;
  if (operation == "locks.scan") success = Scan(request, closed, result, &error);
  else if (operation == "processes.terminate") success = Terminate(request, closed, result);
  else if (operation == "locks.releaseHandles" || operation == "locks.unloadModules") success = MutateRows(operation, request, closed, result);
  else if (operation == "locks.rename") success = Rename(request, closed, result, &error);
  else if (operation == "restartDeletion.prepare") {
    PreparedRestartDeletion prepared;
    WindowsPendingRenameStore default_store;
    PendingRenameStore& store = injected_store ? *injected_store : default_store;
    if (!session_state) error = ERROR_INVALID_HANDLE;
    else success = PrepareRestartDeletion(request.path, request.backup, store, &prepared, &error);
    if (success) {
      GUID guid{};
      wchar_t token[40]{};
      if (FAILED(CoCreateGuid(&guid)) || !StringFromGUID2(guid, token, static_cast<int>(std::size(token)))) { error = ERROR_GEN_FAILURE; success = false; }
      else {
        prepared.token = token;
        if (!session_state->Store(std::move(prepared), closed)) {
          error = closed.load() ? ERROR_CANCELLED : ERROR_ALREADY_EXISTS;
          success = false;
        } else {
          result->token = token;
          result->backup = request.backup;
        }
      }
    }
  }
  else if (operation == "restartDeletion.commit") {
    WindowsPendingRenameStore default_store;
    PendingRenameStore& store = injected_store ? *injected_store : default_store;
    PreparedRestartDeletion prepared;
    if (!session_state) error = ERROR_INVALID_HANDLE;
    else if (!session_state->Take(request.token, FullPath(request.path), FullPath(request.backup), closed, &prepared)) {
      error = closed.load() ? ERROR_CANCELLED : ERROR_INVALID_DATA;
    } else {
      result->backup = prepared.backup;
      success = CommitRestartDeletion(request.path, request.backup, prepared, store,
                                      &result->changed, &error, &closed, &result->queue_outcome);
      result->queued_count = result->changed;
      if (!success && result->queue_outcome != L"unchanged") {
        result->errors.push_back(L"Neustartlöschung wurde nicht vollständig bestätigt. Sicherung: " + result->backup);
      }
    }
  }
  else error = ERROR_INVALID_FUNCTION;
  if (!success && error == ERROR_SUCCESS) error = GetLastError() ? GetLastError() : ERROR_GEN_FAILURE;
  if (native_error) *native_error = error;
  return success;
}

bool ResolveNativeLocks(const std::string& operation, const NativeLocksRequest& request,
                        const std::atomic<bool>& closed, NativeLocksResult* result,
                        DWORD* native_error, NativeLocksSessionState* session_state) {
  return ResolveNativeLocksImpl(operation, request, closed, result, native_error, session_state, nullptr);
}

#ifdef NATIVE_LOCKS_TESTING
bool ResolveNativeLocksWithStoreForTesting(const std::string& operation,
                                           const NativeLocksRequest& request,
                                           const std::atomic<bool>& closed,
                                           NativeLocksResult* result,
                                           DWORD* native_error,
                                           NativeLocksSessionState* session_state,
                                           PendingRenameStore& store) {
  return ResolveNativeLocksImpl(operation, request, closed, result, native_error, session_state, &store);
}
#endif

void CloseNativeLocksSession(const std::shared_ptr<SessionState>& state) {
  if (!state || !state->locks_session) return;
  state->locks_session->Close();
}

#ifdef NATIVE_LOCKS_TESTING
void ForceDebugActiveProcessStopFailure(bool enabled) {
  force_stop_failure.store(enabled);
}

bool TestSafeDebuggerDetach(DWORD process_id, DWORD* native_error) {
  if (native_error) *native_error = ERROR_SUCCESS;
  if (!PrepareSafeDebugger(native_error)) return false;
  if (!DebugActiveProcess(process_id)) {
    const DWORD failure = GetLastError();
    ReleaseSafeDebugger(nullptr);
    if (native_error) *native_error = failure;
    return false;
  }
  DEBUG_EVENT event{};
  if (!WaitForDebugEvent(&event, 3000)) {
    const DWORD failure = GetLastError();
    StopDebugging(process_id);
    ReleaseSafeDebugger(nullptr);
    if (native_error) *native_error = failure;
    return false;
  }
  if (event.dwProcessId != process_id || event.dwDebugEventCode != CREATE_PROCESS_DEBUG_EVENT) {
    { LOCKS_TRACE(NativeLocksTraceApi::CloseDebugEventHandles, event.dwProcessId, event.dwThreadId);
      CloseDebugEventHandles(event); }
    { LOCKS_TRACE(NativeLocksTraceApi::ContinueDebugEvent, event.dwProcessId, event.dwThreadId);
      ContinueDebugEvent(event.dwProcessId, event.dwThreadId, DBG_CONTINUE); }
    { LOCKS_TRACE(NativeLocksTraceApi::DebugActiveProcessStop, process_id, 0);
      StopDebugging(process_id); }
    ReleaseSafeDebugger(nullptr);
    if (native_error) *native_error = ERROR_INVALID_DATA;
    return false;
  }
  { LOCKS_TRACE(NativeLocksTraceApi::CloseDebugEventHandles, event.dwProcessId, event.dwThreadId);
    CloseDebugEventHandles(event); }
  if (!ContinueDebugEvent(event.dwProcessId, event.dwThreadId, DBG_CONTINUE)) {
    const DWORD failure = GetLastError();
    { LOCKS_TRACE(NativeLocksTraceApi::DebugActiveProcessStop, process_id, 0);
      StopDebugging(process_id); }
    ReleaseSafeDebugger(nullptr);
    if (native_error) *native_error = failure;
    return false;
  }
  BOOL stopped = FALSE;
  { LOCKS_TRACE(NativeLocksTraceApi::DebugActiveProcessStop, process_id, 0);
    stopped = StopDebugging(process_id); }
  if (!stopped) {
    const DWORD failure = GetLastError();
    { LOCKS_TRACE(NativeLocksTraceApi::ReleaseSafeDebugger, process_id, 0); ReleaseSafeDebugger(nullptr); }
    if (native_error) *native_error = failure;
    return false;
  }
  return ReleaseSafeDebugger(native_error);
}
#endif

bool PrepareRestartDeletion(const std::wstring& path, const std::wstring& backup,
                            PendingRenameStore& store, PreparedRestartDeletion* prepared,
                            DWORD* error) {
  const std::wstring directory = FullPath(path);
  const std::wstring backup_path = FullPath(backup);
  if (!prepared || directory.empty() || backup_path.empty() || Inside(backup_path, directory)) { if (error) *error = ERROR_INVALID_PARAMETER; return false; }
  PreparedRestartDeletion next;
  next.path = directory;
  next.backup = backup_path;
  if (!CollectRestartFiles(directory, &next.files, error) || !store.Read(&next.pending_bytes, &next.pending_exists, error)) return false;
  if (next.files.size() > MAXDWORD) { if (error) *error = ERROR_NOT_ENOUGH_MEMORY; return false; }
  std::vector<std::wstring> pairs;
  if (!DecodePending(next.pending_bytes, next.pending_exists, &pairs, error)) return false;
  if (!WriteRegistryBackup(backup_path, next.pending_bytes, next.pending_exists, &next.expected_backup_bytes, error)) return false;
  std::vector<uint8_t> current;
  bool exists = false;
  if (!store.Read(&current, &exists, error)) return false;
  if (exists != next.pending_exists || current != next.pending_bytes) { if (error) *error = ERROR_RETRY; return false; }
  next.expected_bytes = next.pending_bytes;
  *prepared = std::move(next);
  return true;
}

bool CommitRestartDeletion(const std::wstring& path, const std::wstring& backup,
                           PreparedRestartDeletion& prepared, PendingRenameStore& store,
                           uint32_t* changed, DWORD* error,
                           const std::atomic<bool>* closed, std::wstring* outcome) {
  if (changed) *changed = 0;
  if (error) *error = ERROR_SUCCESS;
  if (outcome) *outcome = L"unchanged";
  const std::wstring directory = FullPath(path);
  const std::wstring backup_path = FullPath(backup);
  if (directory.empty() || directory != prepared.path || backup_path != prepared.backup || prepared.files.empty()) { if (error) *error = ERROR_INVALID_PARAMETER; return false; }
  std::vector<std::wstring> current_files;
  if (!CollectRestartFiles(directory, &current_files, error)) return false;
  const auto equal_path = [](const std::wstring& left, const std::wstring& right) { return CompareStringOrdinal(left.c_str(), static_cast<int>(left.size()), right.c_str(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL; };
  if (current_files.size() != prepared.files.size() || !std::equal(current_files.begin(), current_files.end(), prepared.files.begin(), equal_path)) { if (error) *error = ERROR_RETRY; return false; }
  std::vector<uint8_t> backup_bytes;
  if (!ReadRegistryBackup(backup_path, &backup_bytes, error)) return false;
  if (backup_bytes != prepared.expected_backup_bytes) { if (error) *error = ERROR_RETRY; return false; }
  std::vector<uint8_t> current;
  bool exists = false;
  if (!store.Read(&current, &exists, error)) return false;
  if (exists != prepared.pending_exists || current != prepared.expected_bytes) { if (error) *error = ERROR_RETRY; return false; }
  std::vector<std::wstring> original_pairs;
  if (!DecodePending(current, exists, &original_pairs, error)) return false;
  std::vector<std::wstring> queued;
  const auto verify_queued = [&](const std::vector<uint8_t>& bytes, bool present) {
    std::vector<std::wstring> verified;
    DWORD verify_error = ERROR_SUCCESS;
    if (queued.empty()) return present == prepared.pending_exists && bytes == prepared.expected_bytes;
    if (!present || !DecodePending(bytes, true, &verified, &verify_error) ||
        verified.size() < original_pairs.size() + queued.size() * 2 ||
        !std::equal(original_pairs.begin(), original_pairs.end(), verified.begin())) return false;
    for (size_t index = 0; index < queued.size(); ++index) {
      const std::wstring source = RestartSource(queued[index]);
      bool found = false;
      for (size_t pair = original_pairs.size(); pair + 1 < verified.size(); pair += 2) {
        if (CompareStringOrdinal(verified[pair].c_str(), static_cast<int>(verified[pair].size()), source.c_str(), static_cast<int>(source.size()), TRUE) == CSTR_EQUAL && verified[pair + 1].empty()) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  };
  DWORD queue_failure = ERROR_SUCCESS;
  for (const auto& file : prepared.files) {
    if (closed && closed->load()) { if (error) *error = ERROR_CANCELLED; break; }
    DWORD queue_error = ERROR_SUCCESS;
    if (!store.QueueDelete(file, &queue_error)) {
      queue_failure = queue_error == ERROR_SUCCESS ? ERROR_GEN_FAILURE : queue_error;
      if (error) *error = queue_failure;
      break;
    }
    queued.push_back(file);
    if (changed) *changed = static_cast<uint32_t>(queued.size());
  }
  if (outcome && !queued.empty()) *outcome = queued.size() == prepared.files.size() ? L"unknown" : L"partial";
  std::vector<uint8_t> after;
  bool after_exists = false;
  DWORD read_error = ERROR_SUCCESS;
  if (!store.Read(&after, &after_exists, &read_error)) {
    if (outcome && !queued.empty()) *outcome = L"unknown";
    if (error && *error == ERROR_SUCCESS) *error = read_error;
    return false;
  }
  if (!verify_queued(after, after_exists)) {
    if (outcome && !queued.empty()) *outcome = L"unknown";
    if (error) *error = queue_failure == ERROR_SUCCESS ? ERROR_WRITE_FAULT : queue_failure;
    return false;
  }
  if (queued.size() != prepared.files.size()) {
    if (error && *error == ERROR_SUCCESS) *error = queue_failure ? queue_failure : ERROR_GEN_FAILURE;
    return false;
  }
  if (outcome) *outcome = L"committed";
  if (error) *error = ERROR_SUCCESS;
  return true;
}

namespace {
struct LockJob {
  std::shared_ptr<SessionState> state;
  std::shared_ptr<NativeLocksSessionState> locks_state;
  std::string operation;
  NativeLocksRequest request;
  NativeLocksResult result;
  napi_deferred deferred = nullptr;
  DWORD error = ERROR_SUCCESS;
  bool success = false;
};

napi_value LockText(napi_env env, const char* value) {
  napi_value result = nullptr;
  if (napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result) != napi_ok) return nullptr;
  return result;
}

napi_value LockText(napi_env env, const std::wstring& value) {
  std::u16string text(value.begin(), value.end());
  napi_value result = nullptr;
  if (napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(text.data()), text.size(), &result) != napi_ok) return nullptr;
  return result;
}

#ifdef NATIVE_LOCKS_TESTING
void AttachTrace(napi_env env, napi_value error) {
  const auto trace = GetNativeLocksTraceState();
  napi_value trace_object = nullptr, api = nullptr, pid = nullptr, handle = nullptr, active = nullptr;
  if (napi_create_object(env, &trace_object) != napi_ok ||
      napi_create_uint32(env, static_cast<uint32_t>(trace.api), &api) != napi_ok ||
      napi_create_uint32(env, trace.process_id, &pid) != napi_ok ||
      napi_create_bigint_uint64(env, static_cast<uint64_t>(trace.handle), &handle) != napi_ok ||
      napi_get_boolean(env, trace.active, &active) != napi_ok) return;
  napi_set_named_property(env, trace_object, "api", api);
  napi_set_named_property(env, trace_object, "processId", pid);
  napi_set_named_property(env, trace_object, "handle", handle);
  napi_set_named_property(env, trace_object, "active", active);
  napi_set_named_property(env, error, "trace", trace_object);
}
#endif

bool ReadText(napi_env env, napi_value object, const char* name, std::wstring* output, bool required) {
  napi_value value = nullptr;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok) return false;
  if (type == napi_undefined && !required) { output->clear(); return true; }
  if (type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || length > 32767) return false;
  std::vector<char16_t> buffer(length + 1);
  if (napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
  output->assign(buffer.begin(), buffer.begin() + static_cast<ptrdiff_t>(length));
  return output->find(L'\0') == std::wstring::npos;
}

bool ReadNumber(napi_env env, napi_value object, const char* name, uint32_t* output, bool required) {
  napi_value value = nullptr;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok) return false;
  if (type == napi_undefined && !required) { *output = 0; return true; }
  return napi_get_value_uint32(env, value, output) == napi_ok;
}

bool ReadRows(napi_env env, napi_value request, std::vector<NativeLockRow>* rows) {
  napi_value value = nullptr;
  if (napi_get_named_property(env, request, "rows", &value) != napi_ok) return false;
  bool is_array = false;
  if (napi_is_array(env, value, &is_array) != napi_ok || !is_array) return false;
  uint32_t count = 0;
  if (napi_get_array_length(env, value, &count) != napi_ok || count > 4096) return false;
  rows->reserve(count);
  for (uint32_t index = 0; index < count; ++index) {
    napi_value item = nullptr;
    if (napi_get_element(env, value, index, &item) != napi_ok) return false;
    NativeLockRow row;
    if (!ReadNumber(env, item, "pid", &row.pid, true) || row.pid == 0 ||
        !ReadText(env, item, "started", &row.started, true) || row.started.empty() ||
        !ReadText(env, item, "file", &row.file, true) || row.file.empty() ||
        !ReadText(env, item, "kind", &row.kind, true) ||
        !ReadText(env, item, "handle", &row.handle, false) ||
        !ReadText(env, item, "module", &row.module, false)) return false;
    if (row.kind != L"handle" && row.kind != L"module" && row.kind != L"image") return false;
    rows->push_back(std::move(row));
  }
  return true;
}

bool ReadRequest(napi_env env, const std::string& operation, napi_value request, NativeLocksRequest* output) {
  napi_valuetype type;
  if (napi_typeof(env, request, &type) != napi_ok || type != napi_object) return false;
  if (operation == "locks.scan") return ReadText(env, request, "path", &output->path, true) && !FullPath(output->path).empty();
  if (operation == "locks.releaseHandles" || operation == "locks.unloadModules" || operation == "processes.terminate") {
    return ReadText(env, request, "path", &output->path, true) && !FullPath(output->path).empty() &&
        ReadNumber(env, request, "hostPid", &output->host_pid, true) && ReadRows(env, request, &output->rows);
  }
  if (operation == "locks.rename") {
    napi_value expected = nullptr, parent = nullptr;
    if (!ReadText(env, request, "path", &output->path, true) || !ReadText(env, request, "destination", &output->destination, true) ||
        napi_get_named_property(env, request, "expected", &expected) != napi_ok || napi_get_named_property(env, request, "expectedParent", &parent) != napi_ok ||
        !ReadText(env, expected, "dev", &output->expected_dev, true) || !ReadText(env, expected, "ino", &output->expected_ino, true) ||
        !ReadText(env, parent, "dev", &output->expected_parent_dev, true) || !ReadText(env, parent, "ino", &output->expected_parent_ino, true)) return false;
    return true;
  }
  if (operation == "restartDeletion.prepare" || operation == "restartDeletion.commit") {
    if (!ReadText(env, request, "path", &output->path, true) || !ReadText(env, request, "backup", &output->backup, true)) return false;
    if (operation == "restartDeletion.commit" && !ReadText(env, request, "token", &output->token, true)) return false;
    return true;
  }
  return false;
}

void ExecuteLocks(napi_env, void* data) {
  auto* job = static_cast<LockJob*>(data);
  try { job->success = ResolveNativeLocks(job->operation, job->request, job->state->closed, &job->result, &job->error, job->locks_state.get()); }
  catch (const std::bad_alloc&) { job->error = ERROR_NOT_ENOUGH_MEMORY; }
  catch (...) { job->error = ERROR_GEN_FAILURE; }
}

napi_value LockResult(napi_env env, const LockJob& job) {
  napi_value result = nullptr;
  napi_value rows = nullptr;
  napi_value errors = nullptr;
  if (napi_create_object(env, &result) != napi_ok || napi_create_array_with_length(env, job.result.rows.size(), &rows) != napi_ok ||
      napi_create_array_with_length(env, job.result.errors.size(), &errors) != napi_ok) return nullptr;
  for (size_t index = 0; index < job.result.rows.size(); ++index) {
    const auto& row = job.result.rows[index];
    napi_value item = nullptr;
    napi_value pid = nullptr;
    napi_value can_terminate = nullptr;
    if (napi_create_object(env, &item) != napi_ok || napi_create_uint32(env, row.pid, &pid) != napi_ok ||
        napi_set_named_property(env, item, "pid", pid) != napi_ok ||
        napi_set_named_property(env, item, "started", LockText(env, row.started)) != napi_ok ||
        napi_set_named_property(env, item, "name", LockText(env, row.name)) != napi_ok ||
        napi_set_named_property(env, item, "executable", LockText(env, row.executable)) != napi_ok ||
        napi_set_named_property(env, item, "commandLine", LockText(env, row.command_line)) != napi_ok ||
        napi_set_named_property(env, item, "file", LockText(env, row.file)) != napi_ok ||
        napi_set_named_property(env, item, "kind", LockText(env, row.kind)) != napi_ok ||
        napi_set_named_property(env, item, "handle", LockText(env, row.handle)) != napi_ok ||
        napi_set_named_property(env, item, "module", LockText(env, row.module)) != napi_ok ||
        napi_get_boolean(env, row.can_terminate, &can_terminate) != napi_ok ||
        napi_set_named_property(env, item, "canTerminate", can_terminate) != napi_ok ||
        napi_set_named_property(env, item, "terminationReason", LockText(env, row.termination_reason)) != napi_ok ||
        napi_set_element(env, rows, static_cast<uint32_t>(index), item) != napi_ok) return nullptr;
  }
  for (size_t index = 0; index < job.result.errors.size(); ++index) {
    if (napi_set_element(env, errors, static_cast<uint32_t>(index), LockText(env, job.result.errors[index])) != napi_ok) return nullptr;
  }
  napi_value inaccessible = nullptr, changed = nullptr;
  if (napi_create_uint32(env, job.result.inaccessible, &inaccessible) != napi_ok || napi_create_uint32(env, job.result.changed, &changed) != napi_ok ||
      napi_set_named_property(env, result, "rows", rows) != napi_ok || napi_set_named_property(env, result, "errors", errors) != napi_ok ||
      napi_set_named_property(env, result, "inaccessible", inaccessible) != napi_ok || napi_set_named_property(env, result, "changed", changed) != napi_ok ||
      napi_set_named_property(env, result, "backup", LockText(env, job.result.backup)) != napi_ok ||
      napi_set_named_property(env, result, "token", LockText(env, job.result.token)) != napi_ok) return nullptr;
  if (job.operation == "restartDeletion.commit") {
    napi_value queued = nullptr, outcome = nullptr;
    if (napi_create_uint32(env, job.result.queued_count, &queued) != napi_ok ||
        napi_create_object(env, &outcome) != napi_ok ||
        napi_set_named_property(env, outcome, "status", LockText(env, job.result.queue_outcome)) != napi_ok ||
        napi_set_named_property(env, outcome, "queuedCount", queued) != napi_ok ||
        napi_set_named_property(env, outcome, "backup", LockText(env, job.result.backup)) != napi_ok ||
        napi_set_named_property(env, result, "queuedCount", queued) != napi_ok ||
        napi_set_named_property(env, result, "outcome", outcome) != napi_ok) return nullptr;
  }
  return result;
}

void CompleteLocks(napi_env env, napi_status status, void* data) {
  auto* job = static_cast<LockJob*>(data);
  const char* code = nullptr;
  if (job->state->closed.load()) code = "SessionClosed";
  else if (status != napi_ok || job->error == ERROR_CANCELLED) code = "Cancelled";
  else if (!job->success) {
    if (job->error == ERROR_ACCESS_DENIED || job->error == ERROR_PRIVILEGE_NOT_HELD) code = "Denied";
    else if (job->error == ERROR_FILE_NOT_FOUND || job->error == ERROR_PATH_NOT_FOUND) code = "NotFound";
    else if (job->error == ERROR_INVALID_PARAMETER || job->error == ERROR_INVALID_DATA) code = "InvalidRequest";
    else code = "NativeFailure";
  }
  if (code) {
    if (job->operation == "restartDeletion.commit" && job->result.queue_outcome == L"partial") code = "PartialOperation";
    const char* message_text = job->operation == "restartDeletion.commit" && job->result.queue_outcome == L"partial"
        ? "Restart deletion was only partially scheduled; inspect outcome and backup."
        : job->operation == "restartDeletion.commit" && job->result.queue_outcome == L"unknown"
        ? "Restart deletion could not be fully verified; inspect outcome and backup."
        : "The native lock operation failed.";
    napi_value message = LockText(env, message_text);
    napi_value error = nullptr;
    if (!message || napi_create_error(env, LockText(env, code), message, &error) != napi_ok) return;
    napi_value native_code = nullptr;
    if (napi_create_uint32(env, job->error, &native_code) == napi_ok) napi_set_named_property(env, error, "nativeCode", native_code);
    napi_set_named_property(env, error, "operation", LockText(env, job->operation.c_str()));
    if (job->operation == "restartDeletion.commit") {
      napi_value changed = nullptr, queued = nullptr, outcome = nullptr, status_value = nullptr, backup = nullptr, errors = nullptr;
      if (napi_create_uint32(env, job->result.changed, &changed) != napi_ok ||
          napi_create_uint32(env, job->result.queued_count, &queued) != napi_ok ||
          napi_create_object(env, &outcome) != napi_ok ||
          napi_create_array_with_length(env, job->result.errors.size(), &errors) != napi_ok) return;
      status_value = LockText(env, job->result.queue_outcome);
      backup = LockText(env, job->result.backup);
      if (!status_value || !backup ||
          napi_set_named_property(env, error, "changed", changed) != napi_ok ||
          napi_set_named_property(env, error, "queuedCount", queued) != napi_ok ||
          napi_set_named_property(env, error, "backup", backup) != napi_ok ||
          napi_set_named_property(env, outcome, "status", status_value) != napi_ok ||
          napi_set_named_property(env, outcome, "queuedCount", queued) != napi_ok ||
          napi_set_named_property(env, outcome, "backup", backup) != napi_ok) return;
      for (size_t index = 0; index < job->result.errors.size(); ++index) {
        if (napi_set_element(env, errors, static_cast<uint32_t>(index), LockText(env, job->result.errors[index])) != napi_ok) return;
      }
      if (napi_set_named_property(env, error, "outcome", outcome) != napi_ok ||
          napi_set_named_property(env, error, "errors", errors) != napi_ok) return;
    }
#ifdef NATIVE_LOCKS_TESTING
    AttachTrace(env, error);
#endif
    napi_reject_deferred(env, job->deferred, error);
  } else {
    napi_value result = LockResult(env, *job);
    if (result) napi_resolve_deferred(env, job->deferred, result);
  }
}
}

napi_value StartNativeLocks(napi_env env, const std::shared_ptr<SessionState>& state,
                            const std::string& operation, napi_value request) {
  constexpr const char* supported[] = {"locks.scan", "locks.releaseHandles", "locks.unloadModules", "locks.rename", "processes.terminate", "restartDeletion.prepare", "restartDeletion.commit"};
  if (std::find_if(std::begin(supported), std::end(supported), [&operation](const char* value) { return operation == value; }) == std::end(supported)) {
    napi_throw_error(env, "UnsupportedOperation", "The native lock operation is unavailable.");
    return nullptr;
  }
  if (state->closed.load()) { napi_throw_error(env, "SessionClosed", "The native session is closed."); return nullptr; }
  auto job = std::make_unique<LockJob>();
  job->state = state;
  if (!state->locks_session) state->locks_session = std::make_shared<NativeLocksSessionState>();
  job->locks_state = state->locks_session;
  job->operation = operation;
  if (!ReadRequest(env, operation, request, &job->request)) { napi_throw_error(env, "InvalidRequest", "The native lock request is invalid."); return nullptr; }
  napi_value promise = nullptr;
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok ||
      QueueWindowsWork(env, operation.c_str(), std::move(job), ExecuteLocks, CompleteLocks) != napi_ok) {
    napi_throw_error(env, "BindingFailure", "The native lock operation could not be queued.");
    return nullptr;
  }
  return promise;
}

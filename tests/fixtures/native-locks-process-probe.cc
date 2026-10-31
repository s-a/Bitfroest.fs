#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <algorithm>
#include <atomic>
#include <iostream>
#include <string>
#include <vector>
#include "locks-win.h"

int wmain(int argc, wchar_t** argv) {
  if (argc == 6 && wcscmp(argv[1], L"--hold") == 0) {
    HANDLE held = CreateFileW(argv[2], GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (held == INVALID_HANDLE_VALUE) return 2;
    HANDLE marker = CreateFileW(argv[3], GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (marker == INVALID_HANDLE_VALUE) { CloseHandle(held); return 3; }
    CloseHandle(marker);
    HANDLE ping = OpenEventW(SYNCHRONIZE, FALSE, argv[4]);
    HANDLE reply = OpenEventW(EVENT_MODIFY_STATE, FALSE, argv[5]);
    if (!ping || !reply) { if (ping) CloseHandle(ping); if (reply) CloseHandle(reply); CloseHandle(held); return 4; }
    for (;;) {
      if (WaitForSingleObject(ping, INFINITE) != WAIT_OBJECT_0 || !SetEvent(reply)) {
        CloseHandle(reply); CloseHandle(ping); CloseHandle(held); return 5;
      }
    }
  }
  if (argc == 4 && wcscmp(argv[1], L"--load") == 0) {
    HMODULE module = LoadLibraryW(argv[2]);
    if (!module) return 2;
    HANDLE marker = CreateFileW(argv[3], GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (marker == INVALID_HANDLE_VALUE) { FreeLibrary(module); return 3; }
    CloseHandle(marker);
    Sleep(INFINITE);
    FreeLibrary(module);
    return 0;
  }

  wchar_t temp[MAX_PATH]{};
  if (!GetTempPathW(MAX_PATH, temp)) return 1;
  const std::wstring root = std::wstring(temp) + L"native-locks-process-probe-" + std::to_wstring(GetCurrentProcessId());
  if (!CreateDirectoryW(root.c_str(), nullptr)) return 1;
  const std::wstring target = root + L"\\held.txt";
  const std::wstring marker_path = root + L"\\ready";
  const std::wstring fixture_dll = root + L"\\fixture.dll";
  const std::wstring module_marker_path = root + L"\\module-ready";
  const std::wstring event_prefix = L"Local\\native-locks-process-probe-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
  const std::wstring ping_name = event_prefix + L"-ping";
  const std::wstring reply_name = event_prefix + L"-reply";
  HANDLE ping_event = CreateEventW(nullptr, FALSE, FALSE, ping_name.c_str());
  HANDLE reply_event = CreateEventW(nullptr, FALSE, FALSE, reply_name.c_str());
  if (!ping_event || !reply_event) { if (ping_event) CloseHandle(ping_event); if (reply_event) CloseHandle(reply_event); return 1; }
  struct Cleanup {
    std::wstring root, target, marker, fixture_dll, module_marker;
    HANDLE ping_event = nullptr;
    HANDLE reply_event = nullptr;
    HANDLE child = nullptr;
    HANDLE module_child = nullptr;
    ~Cleanup() {
      for (HANDLE process : {child, module_child}) {
        if (process && process != INVALID_HANDLE_VALUE) {
          if (WaitForSingleObject(process, 0) != WAIT_OBJECT_0) { TerminateProcess(process, ERROR_PROCESS_ABORTED); WaitForSingleObject(process, 5000); }
          CloseHandle(process);
        }
      }
      if (reply_event) CloseHandle(reply_event);
      if (ping_event) CloseHandle(ping_event);
      DeleteFileW(module_marker.c_str()); DeleteFileW(fixture_dll.c_str()); DeleteFileW(marker.c_str()); DeleteFileW(target.c_str()); RemoveDirectoryW(root.c_str());
    }
  } cleanup{root, target, marker_path, fixture_dll, module_marker_path, ping_event, reply_event};
  HANDLE file = CreateFileW(target.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return 1;
  CloseHandle(file);

  wchar_t executable[MAX_PATH]{};
  const DWORD executable_size = GetModuleFileNameW(nullptr, executable, MAX_PATH);
  if (!executable_size || executable_size >= MAX_PATH) return 1;
  std::wstring command = L"\"" + std::wstring(executable) + L"\" --hold \"" + target + L"\" \"" + marker_path + L"\" \"" + ping_name + L"\" \"" + reply_name + L"\"";
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION child{};
  if (!CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, root.c_str(), &startup, &child)) return 1;
  cleanup.child = child.hProcess;
  CloseHandle(child.hThread);
  HANDLE marker = INVALID_HANDLE_VALUE;
  for (unsigned attempt = 0; attempt < 500; ++attempt) {
    marker = CreateFileW(marker_path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (marker != INVALID_HANDLE_VALUE) break;
    if (WaitForSingleObject(child.hProcess, 10) == WAIT_OBJECT_0) break;
    Sleep(10);
  }
  if (marker != INVALID_HANDLE_VALUE) CloseHandle(marker);
  if (WaitForSingleObject(child.hProcess, 0) == WAIT_OBJECT_0) return 2;

  NativeLocksRequest request;
  request.path = root;
  std::atomic<bool> closed{false};
  NativeLocksResult scan;
  DWORD error = ERROR_SUCCESS;
  if (!ResolveNativeLocks("locks.scan", request, closed, &scan, &error)) return 4;
  const auto found = std::find_if(scan.rows.begin(), scan.rows.end(), [&child, &target](const NativeLockRow& row) {
    return row.pid == child.dwProcessId && row.kind == L"handle" && CompareStringOrdinal(row.file.c_str(), static_cast<int>(row.file.size()), target.c_str(), static_cast<int>(target.size()), TRUE) == CSTR_EQUAL;
  });
  if (found == scan.rows.end() || found->started.empty() || found->executable.empty() || found->command_line.find(L"--hold") == std::wstring::npos) {
    return 5;
  }
  request.host_pid = GetCurrentProcessId();
  request.rows.push_back(*found);
  NativeLocksResult released;
  if (!ResolveNativeLocks("locks.releaseHandles", request, closed, &released, &error) || released.changed != 1 || WaitForSingleObject(child.hProcess, 0) == WAIT_OBJECT_0) {
    std::cerr << "release nativeError=" << error << " changed=" << released.changed << std::endl;
    for (const auto& value : released.errors) std::wcerr << value << std::endl;
    return 6;
  }
  NativeLocksRequest rescan_request;
  rescan_request.path = root;
  NativeLocksResult rescanned;
  if (!ResolveNativeLocks("locks.scan", rescan_request, closed, &rescanned, &error) ||
      std::any_of(rescanned.rows.begin(), rescanned.rows.end(), [&child, &target](const NativeLockRow& row) { return row.pid == child.dwProcessId && row.kind == L"handle" && CompareStringOrdinal(row.file.c_str(), static_cast<int>(row.file.size()), target.c_str(), static_cast<int>(target.size()), TRUE) == CSTR_EQUAL; })) {
    return 7;
  }
  if (!TestSafeDebuggerDetach(child.dwProcessId, &error) || WaitForSingleObject(child.hProcess, 0) == WAIT_OBJECT_0) {
    std::cerr << "debugger-abort nativeError=" << error << std::endl;
    return 8;
  }
  ResetEvent(reply_event);
  if (!SetEvent(ping_event) || WaitForSingleObject(reply_event, 5000) != WAIT_OBJECT_0) {
    std::cerr << "debugger-resume nativeError=" << GetLastError() << std::endl;
    return 8;
  }
  NativeLocksResult terminated;
  if (!ResolveNativeLocks("processes.terminate", request, closed, &terminated, &error) || terminated.changed != 1 || WaitForSingleObject(child.hProcess, 5000) != WAIT_OBJECT_0) {
    std::cerr << "terminate nativeError=" << error << " changed=" << terminated.changed << std::endl;
    for (const auto& value : terminated.errors) std::wcerr << value << std::endl;
    return 9;
  }

  wchar_t system[MAX_PATH]{};
  const UINT system_length = GetSystemDirectoryW(system, MAX_PATH);
  if (!system_length || system_length >= MAX_PATH) return 9;
  const std::wstring source_dll = std::wstring(system) + L"\\version.dll";
  if (!CopyFileW(source_dll.c_str(), fixture_dll.c_str(), TRUE)) return 9;
  std::wstring module_command = L"\"" + std::wstring(executable) + L"\" --load \"" + fixture_dll + L"\" \"" + module_marker_path + L"\"";
  PROCESS_INFORMATION module_child{};
  if (!CreateProcessW(executable, module_command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, root.c_str(), &startup, &module_child)) return 9;
  cleanup.module_child = module_child.hProcess;
  CloseHandle(module_child.hThread);
  HANDLE module_marker = INVALID_HANDLE_VALUE;
  for (unsigned attempt = 0; attempt < 500; ++attempt) {
    module_marker = CreateFileW(module_marker_path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (module_marker != INVALID_HANDLE_VALUE) break;
    if (WaitForSingleObject(module_child.hProcess, 10) == WAIT_OBJECT_0) break;
    Sleep(10);
  }
  if (module_marker != INVALID_HANDLE_VALUE) CloseHandle(module_marker);
  if (WaitForSingleObject(module_child.hProcess, 0) == WAIT_OBJECT_0) return 9;
  NativeLocksRequest module_request;
  module_request.path = root;
  NativeLocksResult module_scan;
  if (!ResolveNativeLocks("locks.scan", module_request, closed, &module_scan, &error)) return 9;
  const auto module_row = std::find_if(module_scan.rows.begin(), module_scan.rows.end(), [&module_child, &fixture_dll](const NativeLockRow& row) {
    return row.pid == module_child.dwProcessId && row.kind == L"module" && CompareStringOrdinal(row.file.c_str(), static_cast<int>(row.file.size()), fixture_dll.c_str(), static_cast<int>(fixture_dll.size()), TRUE) == CSTR_EQUAL;
  });
  if (module_row == module_scan.rows.end()) return 9;
  module_request.host_pid = GetCurrentProcessId();
  module_request.rows.push_back(*module_row);
  NativeLocksResult unloaded;
  if (!ResolveNativeLocks("locks.unloadModules", module_request, closed, &unloaded, &error) || unloaded.changed != 1 || WaitForSingleObject(module_child.hProcess, 0) == WAIT_OBJECT_0) {
    std::cerr << "unload nativeError=" << error << " changed=" << unloaded.changed << std::endl;
    for (const auto& value : unloaded.errors) std::wcerr << value << std::endl;
    return 10;
  }
  NativeLocksResult module_rescan;
  if (!ResolveNativeLocks("locks.scan", module_request, closed, &module_rescan, &error) ||
      std::any_of(module_rescan.rows.begin(), module_rescan.rows.end(), [&module_child, &fixture_dll](const NativeLockRow& row) { return row.pid == module_child.dwProcessId && row.kind == L"module" && CompareStringOrdinal(row.file.c_str(), static_cast<int>(row.file.size()), fixture_dll.c_str(), static_cast<int>(fixture_dll.size()), TRUE) == CSTR_EQUAL; })) {
    return 11;
  }
  NativeLocksResult module_terminated;
  if (!ResolveNativeLocks("processes.terminate", module_request, closed, &module_terminated, &error) || module_terminated.changed != 1 || WaitForSingleObject(module_child.hProcess, 5000) != WAIT_OBJECT_0) {
    return 12;
  }
  std::cout << "scan=ok handle=ok start-identity=ok commandline=ok release-owned-handle=ok debugger-detach-resume=ok module-unload=ok terminate-owned-children=ok inaccessible=" << scan.inaccessible << std::endl;
  return 0;
}

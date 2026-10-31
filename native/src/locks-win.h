#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <node_api.h>
#include <memory>
#include <atomic>
#include <cstdint>
#include <string>
#include <vector>
#include <mutex>
#include <unordered_map>
#include "session.h"

struct NativeLockRow {
  uint32_t pid = 0;
  std::wstring started;
  std::wstring name;
  std::wstring executable;
  std::wstring command_line;
  std::wstring file;
  std::wstring kind;
  std::wstring handle;
  std::wstring module;
  bool can_terminate = true;
  std::wstring termination_reason;
};

struct NativeLocksRequest {
  std::wstring path;
  std::wstring destination;
  std::wstring backup;
  std::wstring token;
  std::wstring expected_dev;
  std::wstring expected_ino;
  std::wstring expected_parent_dev;
  std::wstring expected_parent_ino;
  uint32_t host_pid = 0;
  std::vector<NativeLockRow> rows;
};

struct NativeLocksResult {
  std::vector<NativeLockRow> rows;
  std::vector<std::wstring> errors;
  uint32_t inaccessible = 0;
  uint32_t changed = 0;
  uint32_t queued_count = 0;
  std::wstring queue_outcome = L"unchanged";
  std::wstring backup;
  std::wstring token;
};

class PendingRenameStore {
 public:
  virtual ~PendingRenameStore() = default;
  virtual bool Read(std::vector<uint8_t>* bytes, bool* exists, DWORD* error) = 0;
  virtual bool QueueDelete(const std::wstring& path, DWORD* error) = 0;
};

struct PreparedRestartDeletion {
  std::wstring path;
  std::wstring backup;
  std::wstring token;
  std::vector<std::wstring> files;
  std::vector<uint8_t> pending_bytes;
  bool pending_exists = false;
  std::vector<uint8_t> expected_bytes;
  std::vector<uint8_t> expected_backup_bytes;
};

struct NativeLocksSessionState {
  std::mutex mutex;
  std::unordered_map<std::wstring, PreparedRestartDeletion> prepared_deletions;
  bool closed = false;

  bool Store(PreparedRestartDeletion prepared, const std::atomic<bool>& session_closed) {
    std::lock_guard<std::mutex> lock(mutex);
    if (closed || session_closed.load()) return false;
    return prepared_deletions.emplace(prepared.token, std::move(prepared)).second;
  }

  bool Take(const std::wstring& token, const std::wstring& path, const std::wstring& backup,
            const std::atomic<bool>& session_closed, PreparedRestartDeletion* prepared) {
    std::lock_guard<std::mutex> lock(mutex);
    if (!prepared || closed || session_closed.load()) return false;
    auto found = prepared_deletions.find(token);
    if (found == prepared_deletions.end() || found->second.path != path || found->second.backup != backup) return false;
    *prepared = std::move(found->second);
    prepared_deletions.erase(found);
    return true;
  }

  void Close() {
    std::lock_guard<std::mutex> lock(mutex);
    closed = true;
    prepared_deletions.clear();
  }
};

bool PrepareRestartDeletion(const std::wstring& path, const std::wstring& backup,
                            PendingRenameStore& store, PreparedRestartDeletion* prepared,
                            DWORD* error);
bool CommitRestartDeletion(const std::wstring& path, const std::wstring& backup,
                           PreparedRestartDeletion& prepared, PendingRenameStore& store,
                           uint32_t* changed, DWORD* error,
                           const std::atomic<bool>* closed = nullptr,
                           std::wstring* outcome = nullptr);

bool ResolveNativeLocks(const std::string& operation, const NativeLocksRequest& request,
                        const std::atomic<bool>& closed, NativeLocksResult* result,
                        DWORD* native_error, NativeLocksSessionState* session_state = nullptr);
void CloseNativeLocksSession(const std::shared_ptr<SessionState>& state);
bool NativeLocksSupported();

#ifdef NATIVE_LOCKS_TESTING
enum class NativeLocksTraceApi : uint32_t {
  None,
  NtQuerySystemInformation,
  OpenProcess,
  GetProcessTimes,
  QueryFullProcessImageName,
  QueryInformationProcess,
  IsWow64Process,
  ReadProcessMemory,
  GetFinalPathNameByHandle,
  EnumProcessModules,
  GetModuleFileNameEx,
  PrepareSafeDebugger,
  DebugActiveProcess,
  WaitForDebugEvent,
  DuplicateValidate,
  DuplicateCloseSource,
  ContinueDebugEvent,
  DebugActiveProcessStop,
  ReleaseSafeDebugger,
  CloseDebugEventHandles,
  ValidateMutation
};
struct NativeLocksTraceState {
  NativeLocksTraceApi api = NativeLocksTraceApi::None;
  uint32_t process_id = 0;
  uintptr_t handle = 0;
  bool active = false;
};
NativeLocksTraceState GetNativeLocksTraceState();
void ForceDebugActiveProcessStopFailure(bool enabled);
bool TestSafeDebuggerDetach(DWORD process_id, DWORD* native_error);
bool ResolveNativeLocksWithStoreForTesting(const std::string& operation,
                                           const NativeLocksRequest& request,
                                           const std::atomic<bool>& closed,
                                           NativeLocksResult* result,
                                           DWORD* native_error,
                                           NativeLocksSessionState* session_state,
                                           PendingRenameStore& store);
#endif

napi_value StartNativeLocks(napi_env env, const std::shared_ptr<SessionState>& state,
                            const std::string& operation, napi_value request);

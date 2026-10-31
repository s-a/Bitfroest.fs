#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <utility>
#include <vector>
#include "file-transfer-win.h"

namespace {
constexpr DWORD kOpenFlags = FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS;

struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  Handle() = default;
  explicit Handle(HANDLE input) : value(input) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(other.value) { other.value = INVALID_HANDLE_VALUE; }
  Handle& operator=(Handle&& other) noexcept {
    if (this != &other) {
      if (value != INVALID_HANDLE_VALUE) CloseHandle(value);
      value = other.value;
      other.value = INVALID_HANDLE_VALUE;
    }
    return *this;
  }
  bool valid() const { return value != INVALID_HANDLE_VALUE; }
};

struct NativeHandleIdentity {
  FileTransferIdentity reported;
  uint64_t last_write_filetime = 0;
  uint64_t change_filetime = 0;
};

struct CopyContext {
  const std::function<bool()>* should_cancel = nullptr;
  const std::function<void(const FileTransferProgress&)>* on_progress = nullptr;
  const std::atomic<bool>* shutdown = nullptr;
  FileTransferResult* result = nullptr;
  Handle operation_destination;
  std::optional<FileTransferOwnedDestination> progress_identity;
  bool callback_failed = false;
  ULONGLONG last_report = 0;
  uint64_t last_transferred = UINT64_MAX;
};

bool IsDriveRoot(const std::wstring& value) {
  return value.size() >= 3 && ((value[0] >= L'A' && value[0] <= L'Z') || (value[0] >= L'a' && value[0] <= L'z')) && value[1] == L':' && value[2] == L'\\';
}
size_t RootLength(const std::wstring& value) {
  if (IsDriveRoot(value)) return 3;
  if (value.size() > 4 && value[0] == L'\\' && value[1] == L'\\' && value[2] != L'.' && value[2] != L'?' ) {
    const size_t server_end = value.find(L'\\', 2);
    if (server_end == std::wstring::npos || server_end == 2 || server_end + 1 >= value.size()) return 0;
    const size_t share_end = value.find(L'\\', server_end + 1);
    return share_end == std::wstring::npos ? value.size() : share_end + 1;
  }
  return 0;
}
bool Clean(std::wstring* value) {
  if (!value || value->empty() || value->find(L'\0') != std::wstring::npos) return false;
  std::replace(value->begin(), value->end(), L'/', L'\\');
  if (value->compare(0, 8, L"\\\\?\\UNC\\") == 0) *value = L"\\\\" + value->substr(8);
  else if (value->compare(0, 4, L"\\\\?\\") == 0) *value = value->substr(4);
  const size_t root = RootLength(*value);
  if (!root || value->find(L':', root) != std::wstring::npos) return false;
  for (size_t start = root; start <= value->size();) {
    const size_t end = value->find(L'\\', start);
    if (value->substr(start, end - start) == L"..") return false;
    if (end == std::wstring::npos) break;
    start = end + 1;
  }
  const DWORD required = GetFullPathNameW(value->c_str(), 0, nullptr, nullptr);
  if (!required || required > 32767) return false;
  std::vector<wchar_t> buffer(required);
  const DWORD written = GetFullPathNameW(value->c_str(), required, buffer.data(), nullptr);
  if (!written || written >= required) return false;
  value->assign(buffer.data(), written);
  while (value->size() > RootLength(*value) && value->back() == L'\\') value->pop_back();
  return true;
}
bool EqualPath(const std::wstring& left, const std::wstring& right) {
  return CompareStringOrdinal(left.c_str(), static_cast<int>(left.size()), right.c_str(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}
bool Below(const std::wstring& value, const std::wstring& root) {
  if (value.size() == root.size()) return EqualPath(value, root);
  return value.size() > root.size() && (root.back() == L'\\' || value[root.size()] == L'\\') &&
         CompareStringOrdinal(value.c_str(), static_cast<int>(root.size()), root.c_str(), static_cast<int>(root.size()), TRUE) == CSTR_EQUAL;
}
std::wstring Extended(const std::wstring& value) {
  return value.compare(0, 2, L"\\\\") == 0 ? L"\\\\?\\UNC\\" + value.substr(2) : L"\\\\?\\" + value;
}
Handle Open(const std::wstring& path, DWORD access, DWORD share) {
  Handle handle(CreateFileW(Extended(path).c_str(), access, share, nullptr, OPEN_EXISTING, kOpenFlags, nullptr));
  if (handle.value == INVALID_HANDLE_VALUE) throw GetLastError();
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(handle.value, &info)) throw GetLastError();
  if (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) throw static_cast<DWORD>(ERROR_CANT_ACCESS_FILE);
  return handle;
}
void HoldParents(const std::wstring& path, std::vector<Handle>* handles) {
  const size_t root = RootLength(path);
  const size_t last = path.find_last_of(L'\\');
  if (!root || last == std::wstring::npos || last < root) throw static_cast<DWORD>(ERROR_INVALID_NAME);
  handles->push_back(Open(path.substr(0, root), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE));
  for (size_t end = root; end <= last; ++end) {
    if (end == last || path[end] == L'\\') handles->push_back(Open(path.substr(0, end), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE));
  }
}
uint64_t Pair(DWORD high, DWORD low) { return (static_cast<uint64_t>(high) << 32) | low; }
std::string NodeNanoseconds(LARGE_INTEGER filetime) {
  constexpr int64_t epoch = 116444736000000000LL;
  constexpr int64_t ticks_per_second = 10000000LL;
  const int64_t unix_ticks = filetime.QuadPart - epoch;
  int64_t seconds = unix_ticks / ticks_per_second;
  int64_t nanoseconds = (unix_ticks % ticks_per_second) * 100;
  if (nanoseconds < 0) { --seconds; nanoseconds += 1000000000LL; }
  const uint64_t node_seconds = static_cast<uint32_t>(seconds);
  return std::to_string(node_seconds * 1000000000ULL + static_cast<uint64_t>(nanoseconds));
}
NativeHandleIdentity Identity(HANDLE handle) {
  BY_HANDLE_FILE_INFORMATION info{};
  FILE_BASIC_INFO basic{};
  if (!GetFileInformationByHandle(handle, &info) || !GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic))) throw GetLastError();
  NativeHandleIdentity result;
  result.reported.dev = std::to_string(info.dwVolumeSerialNumber);
  result.reported.ino = std::to_string(Pair(info.nFileIndexHigh, info.nFileIndexLow));
  result.reported.size = std::to_string(Pair(info.nFileSizeHigh, info.nFileSizeLow));
  result.last_write_filetime = static_cast<uint64_t>(basic.LastWriteTime.QuadPart);
  result.change_filetime = static_cast<uint64_t>(basic.ChangeTime.QuadPart);
  result.reported.mtime_ns = NodeNanoseconds(basic.LastWriteTime);
  result.reported.ctime_ns = NodeNanoseconds(basic.ChangeTime);
  return result;
}
bool SameIdentity(const FileTransferIdentity& left, const FileTransferIdentity& right) {
  return left.dev == right.dev && left.ino == right.ino && left.size == right.size && left.mtime_ns == right.mtime_ns && left.ctime_ns == right.ctime_ns;
}
bool SameIdentity(const NativeHandleIdentity& left, const FileTransferIdentity& right) {
  return SameIdentity(left.reported, right);
}
bool IsCancelled(CopyContext* context) noexcept {
  if (!context) return true;
  try {
    return (context->shutdown && context->shutdown->load()) || (context->should_cancel && *context->should_cancel && (*context->should_cancel)());
  } catch (...) {
    context->callback_failed = true;
    return true;
  }
}
enum class TargetState { kMissing, kPresent, kUnknown };
TargetState QueryFinalDestination(const std::wstring& target, CopyContext* context, FileTransferOwnedDestination* owned) {
  if (!context || !context->operation_destination.valid()) {
    try {
      Handle path = Open(target, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
      return path.valid() ? TargetState::kUnknown : TargetState::kMissing;
    } catch (DWORD error) {
      if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return TargetState::kMissing;
      return TargetState::kUnknown;
    } catch (...) { return TargetState::kUnknown; }
  }
  bool operation_handle_released = false;
  try {
    const NativeHandleIdentity operation_identity = Identity(context->operation_destination.value);
    context->operation_destination = Handle();
    operation_handle_released = true;
    Handle path = Open(target, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    const NativeHandleIdentity path_identity = Identity(path.value);
    if (operation_identity.reported.dev != path_identity.reported.dev || operation_identity.reported.ino != path_identity.reported.ino ||
        operation_identity.last_write_filetime != path_identity.last_write_filetime ||
        operation_identity.change_filetime != path_identity.change_filetime ||
        !SameIdentity(operation_identity.reported, path_identity.reported)) return TargetState::kUnknown;
    owned->identity = operation_identity.reported;
    return TargetState::kPresent;
  } catch (DWORD error) {
    if (!operation_handle_released) {
      context->operation_destination = Handle();
      try {
        Handle path = Open(target, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
        return TargetState::kUnknown;
      } catch (DWORD path_error) {
        if (path_error == ERROR_FILE_NOT_FOUND || path_error == ERROR_PATH_NOT_FOUND) return TargetState::kMissing;
      } catch (...) {}
      return TargetState::kUnknown;
    }
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return TargetState::kMissing;
    return TargetState::kUnknown;
  } catch (...) {
    context->operation_destination = Handle();
    try {
      Handle path = Open(target, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
      return TargetState::kUnknown;
    } catch (DWORD path_error) {
      if (path_error == ERROR_FILE_NOT_FOUND || path_error == ERROR_PATH_NOT_FOUND) return TargetState::kMissing;
    } catch (...) {}
    return TargetState::kUnknown;
  }
}
DWORD CALLBACK ProgressRoutine(LARGE_INTEGER total, LARGE_INTEGER transferred, LARGE_INTEGER, LARGE_INTEGER, DWORD, DWORD,
                               HANDLE, HANDLE destination, LPVOID opaque) {
  auto* context = static_cast<CopyContext*>(opaque);
  if (IsCancelled(context)) return PROGRESS_CANCEL;
  const uint64_t bytes = transferred.QuadPart < 0 ? 0 : static_cast<uint64_t>(transferred.QuadPart);
  const uint64_t all = total.QuadPart < 0 ? 0 : static_cast<uint64_t>(total.QuadPart);
  const ULONGLONG now = GetTickCount64();
  if (bytes != all && (bytes == context->last_transferred || now - context->last_report < 50)) return PROGRESS_CONTINUE;
  FileTransferProgress progress;
  progress.transferred = bytes;
  progress.total = all;
  try {
    if (destination && destination != INVALID_HANDLE_VALUE) {
      if (!context->operation_destination.valid()) {
        HANDLE duplicate = nullptr;
        if (DuplicateHandle(GetCurrentProcess(), destination, GetCurrentProcess(), &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
          context->operation_destination = Handle(duplicate);
        }
      }
      if (context->operation_destination.valid()) {
        progress.owned_destination = FileTransferOwnedDestination{Identity(context->operation_destination.value).reported};
        context->progress_identity = progress.owned_destination;
      }
    }
  } catch (...) {}
  try {
    if (context->on_progress && *context->on_progress) (*context->on_progress)(progress);
  } catch (...) {
    context->callback_failed = true;
    return PROGRESS_CANCEL;
  }
  context->last_transferred = bytes;
  context->last_report = now;
  return IsCancelled(context) ? PROGRESS_CANCEL : PROGRESS_CONTINUE;
}
void Unchanged(FileTransferResult* result, const char* code, const char* message, DWORD error, bool cancelled = false) {
  result->status = FileTransferStatus::kUnchanged;
  result->cancelled = cancelled;
  result->native_error = error;
  result->code = code;
  result->message = message;
}
bool Validate(const FileTransferRequest& request, FileTransferResult* result, std::vector<Handle>* parents,
              Handle* source, std::wstring* source_path, std::wstring* target_path) {
  std::wstring from = request.source, to = request.target;
  if (!Clean(&from) || !Clean(&to) || EqualPath(from, to) || request.roots.empty()) {
    Unchanged(result, "InvalidRequest", "Invalid copy paths.", ERROR_INVALID_PARAMETER); return false;
  }
  std::vector<std::wstring> roots;
  roots.reserve(request.roots.size());
  for (auto root : request.roots) {
    if (!Clean(&root)) { Unchanged(result, "InvalidRequest", "Invalid allowed root.", ERROR_INVALID_PARAMETER); return false; }
    roots.push_back(std::move(root));
  }
  const auto allowed = [&roots](const std::wstring& value) { return std::any_of(roots.begin(), roots.end(), [&value](const std::wstring& root) { return Below(value, root); }); };
  if (!allowed(from) || !allowed(to)) { Unchanged(result, "OutsideRoots", "A copy path is outside the allowed roots.", ERROR_ACCESS_DENIED); return false; }
  *source_path = from;
  *target_path = to;
  try {
    HoldParents(from, parents);
    HoldParents(to, parents);
    *source = Open(from, GENERIC_READ | FILE_READ_ATTRIBUTES, FILE_SHARE_READ);
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(source->value, &info)) throw GetLastError();
    if (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) throw static_cast<DWORD>(ERROR_DIRECTORY);
    if (!SameIdentity(Identity(source->value), request.expected_source)) {
      Unchanged(result, "IdentityChanged", "The source changed before copying.", ERROR_FILE_INVALID); return false;
    }
  } catch (DWORD error) {
    Unchanged(result, error == ERROR_CANT_ACCESS_FILE ? "ReparsePoint" : "NativeFailure",
              "The copy source or an ancestor could not be validated.", error); return false;
  }
  return true;
}
void Copy(const FileTransferRequest& request, const std::function<bool()>& should_cancel,
          const std::function<void(const FileTransferProgress&)>& on_progress, const std::atomic<bool>& shutdown, BOOL* cancel_flag,
          FileTransferResult* result) {
  *result = FileTransferResult{};
  result->status = FileTransferStatus::kUnknown;
  CopyContext context{&should_cancel, &on_progress, &shutdown, result};
  std::vector<Handle> parents;
  Handle source;
  std::wstring source_path, target_path;
  if (!Validate(request, result, &parents, &source, &source_path, &target_path)) {
    const DWORD validation_error = result->native_error;
    const bool cancel_requested = InterlockedCompareExchange(reinterpret_cast<volatile LONG*>(cancel_flag), 0, 0) != FALSE || IsCancelled(&context);
    if (cancel_requested && (validation_error == ERROR_OPERATION_ABORTED || validation_error == ERROR_REQUEST_ABORTED)) {
      result->cancelled = true;
      result->code = "Cancelled";
      result->message = "The copy was cancelled during validation.";
    }
    return;
  }
  if (IsCancelled(&context)) { Unchanged(result, "Cancelled", "The copy was cancelled before it started.", ERROR_REQUEST_ABORTED, true); return; }
  const BOOL copied = CopyFileExW(Extended(source_path).c_str(), Extended(target_path).c_str(), ProgressRoutine,
                                  &context, cancel_flag, COPY_FILE_FAIL_IF_EXISTS);
  const DWORD error = copied ? ERROR_SUCCESS : GetLastError();
  result->native_error = error;
  const bool cancel_requested = InterlockedCompareExchange(reinterpret_cast<volatile LONG*>(cancel_flag), 0, 0) != FALSE || IsCancelled(&context);
  result->cancelled = !copied && cancel_requested &&
      (error == ERROR_REQUEST_ABORTED || error == ERROR_OPERATION_ABORTED);
  if (context.callback_failed) {
    result->code = "ProgressCallbackFailed";
    result->message = "Copy progress could not be delivered.";
  }
  FileTransferOwnedDestination final_identity;
  const TargetState target_state = QueryFinalDestination(target_path, &context, &final_identity);
  const bool same_destination = target_state == TargetState::kPresent;
  if (copied) {
    if (same_destination) {
      result->status = FileTransferStatus::kCommitted;
      result->owned_destination = std::move(final_identity);
      result->code = "Committed";
      result->message.clear();
    } else {
      result->status = FileTransferStatus::kUnknown;
      result->code = "OutcomeUnknown";
      result->message = "The copied destination could not be matched to the operation handle.";
    }
    return;
  }
  if (same_destination) {
    result->status = FileTransferStatus::kPartial;
    result->owned_destination = std::move(final_identity);
    if (result->code.empty()) result->code = result->cancelled ? "CancelledWithPartial" : "NativeFailureWithPartial";
    if (result->message.empty()) result->message = "The native copy left a verified partial destination.";
  } else if (target_state == TargetState::kMissing || error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS) {
    result->status = FileTransferStatus::kUnchanged;
    if (result->code.empty()) result->code = result->cancelled ? "Cancelled" : "AlreadyExists";
    if (result->message.empty()) result->message = result->cancelled ? "The copy was cancelled before creating a destination." : "The destination already exists.";
  } else {
    result->status = FileTransferStatus::kUnknown;
    result->owned_destination.reset();
    result->code = context.progress_identity ? "DestinationOwnershipUnknown" : "OutcomeUnknown";
    result->message = "The native copy stopped before destination ownership could be confirmed.";
  }
}
}

namespace {
class NativeFileTransferSession final : public FileTransferSession {
 public:
  bool Copy(const FileTransferRequest& request, const std::function<bool()>& should_cancel,
            const std::function<void(const FileTransferProgress&)>& on_progress, FileTransferResult* result,
            uint64_t request_ticket) override {
    if (!result) return false;
    HANDLE thread_handle = nullptr;
    DWORD thread_handle_error = ERROR_SUCCESS;
    {
      std::lock_guard<std::mutex> lock(lifecycle_mutex_);
      if (active_) { Unchanged(result, "Busy", "A file copy is already active in this session.", ERROR_BUSY); return false; }
      if (queued_ > 0) --queued_;
      active_ = true;
      if (!request_ticket) {
        ++next_ticket_;
        if (!next_ticket_) ++next_ticket_;
        request_ticket = next_ticket_;
      }
      active_ticket_ = request_ticket;
      io_scope_active_ = true;
      active_thread_ = nullptr;
      if (DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &thread_handle,
                          THREAD_TERMINATE, FALSE, 0)) active_thread_ = thread_handle;
      else thread_handle_error = GetLastError();
      InterlockedExchange(reinterpret_cast<volatile LONG*>(&cancel_flag_), FALSE);
    }
    lifecycle_changed_.notify_all();
    if (thread_handle_error != ERROR_SUCCESS) {
      bool cancel_requested = shutdown_.load();
      try { cancel_requested = cancel_requested || (should_cancel && should_cancel()); } catch (...) {}
      if (cancel_requested) Unchanged(result, "Cancelled", "The copy was cancelled before native I/O started.", ERROR_REQUEST_ABORTED, true);
      else Unchanged(result, "IoCancelUnavailable", "A request-scoped I/O cancellation handle could not be created.", thread_handle_error);
      EndRequestIo(request_ticket);
      return true;
    }
    if (shutdown_.load()) {
      Unchanged(result, "SessionClosed", "The native copy session is closed.", ERROR_OPERATION_ABORTED, true);
      EndRequestIo(request_ticket);
      return true;
    }
    try { ::Copy(request, should_cancel, on_progress, shutdown_, &cancel_flag_, result); }
    catch (const std::bad_alloc&) { result->status = FileTransferStatus::kUnknown; result->code = "ResourceExhausted"; result->message = "Native copy resources were exhausted."; }
    catch (...) { result->status = FileTransferStatus::kUnknown; result->code = "NativeFailure"; result->message = "The native copy failed unexpectedly."; }
    EndRequestIo(request_ticket);
    return true;
  }
  void FinishCopy() override {
    {
      std::lock_guard<std::mutex> lock(lifecycle_mutex_);
      active_ = false;
    }
    lifecycle_changed_.notify_all();
  }
  bool RegisterQueuedCopy() override {
    std::lock_guard<std::mutex> lock(lifecycle_mutex_);
    if (shutdown_.load()) return false;
    ++queued_;
    return true;
  }
  void CancelQueuedCopy() override {
    {
      std::lock_guard<std::mutex> lock(lifecycle_mutex_);
      if (queued_ > 0) --queued_;
    }
    lifecycle_changed_.notify_all();
  }
  void RequestCancel() override { InterlockedExchange(reinterpret_cast<volatile LONG*>(&cancel_flag_), TRUE); }
  void RequestIoCancel(uint64_t request_ticket) override {
    std::lock_guard<std::mutex> lock(lifecycle_mutex_);
    if (request_ticket && io_scope_active_ && active_ticket_ == request_ticket && active_thread_) {
      CancelSynchronousIo(active_thread_);
    }
  }
  void Shutdown() override {
    shutdown_.store(true);
    RequestCancel();
    uint64_t request_ticket = 0;
    {
      std::lock_guard<std::mutex> lock(lifecycle_mutex_);
      if (io_scope_active_) request_ticket = active_ticket_;
    }
    if (request_ticket) RequestIoCancel(request_ticket);
  }
  void AwaitStopped() override {
    std::unique_lock<std::mutex> lock(lifecycle_mutex_);
    lifecycle_changed_.wait(lock, [this] { return !active_ && queued_ == 0; });
  }

 private:
  void EndRequestIo(uint64_t request_ticket) {
    {
      std::lock_guard<std::mutex> lock(lifecycle_mutex_);
      if (io_scope_active_ && active_ticket_ == request_ticket) {
        io_scope_active_ = false;
        active_ticket_ = 0;
        if (active_thread_) CloseHandle(active_thread_);
        active_thread_ = nullptr;
      }
    }
    lifecycle_changed_.notify_all();
  }
  std::atomic<bool> shutdown_{false};
  BOOL cancel_flag_ = FALSE;
  std::mutex lifecycle_mutex_;
  std::condition_variable lifecycle_changed_;
  bool active_ = false;
  size_t queued_ = 0;
  uint64_t next_ticket_ = 0;
  uint64_t active_ticket_ = 0;
  HANDLE active_thread_ = nullptr;
  bool io_scope_active_ = false;
};
}

std::shared_ptr<FileTransferSession> CreateNativeFileTransferSession() {
  return std::make_shared<NativeFileTransferSession>();
}
void ExecuteNativeCopy(const FileTransferRequest& request, const std::function<bool()>& should_cancel,
                       const std::function<void(const FileTransferProgress&)>& on_progress, FileTransferResult* result) {
  auto session = CreateNativeFileTransferSession();
  if (session->Copy(request, should_cancel, on_progress, result)) session->FinishCopy();
  session->Shutdown();
  session->AwaitStopped();
}

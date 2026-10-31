#include "clipboard-win.h"
#include "clipboard-ole-engine.h"
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <objidl.h>
#include <ole2.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <thread>
#include <utility>
#include <vector>
#ifdef CLIPBOARD_TESTING
#include "../../tests/native-clipboard-fake-backend.h"
#endif

namespace {
constexpr UINT kWorkMessage = WM_APP + 41;
enum class Operation { Read, Write, Acknowledge };
struct Request { Operation operation = Operation::Read; std::wstring token, mode; std::vector<std::wstring> paths, remaining; };
struct Result { HRESULT status = E_FAIL; bool matched = false; std::wstring mode, token; std::vector<std::wstring> paths; std::vector<std::string> errors; };

napi_value Fail(napi_env env, const char* code, const char* message) { napi_throw_error(env, code, message); return nullptr; }
bool PinModuleForAsyncWork() {
  static std::once_flag once;
  static bool pinned = false;
  std::call_once(once, [] {
    HMODULE module = nullptr;
    pinned = GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
        reinterpret_cast<LPCWSTR>(&PinModuleForAsyncWork), &module) != FALSE;
  });
  return pinned;
}
bool String(napi_env env, napi_value value, size_t limit, std::wstring* output) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || length > limit) return false;
  std::vector<char16_t> buffer(length + 1);
  if (napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
  output->assign(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(length));
  return output->find(L'\0') == std::wstring::npos;
}
bool Field(napi_env env, napi_value object, const char* name, size_t limit, std::wstring* output) { napi_value value; return napi_get_named_property(env, object, name, &value) == napi_ok && String(env, value, limit, output); }
bool Absolute(const std::wstring& path) {
  const bool drive = path.size() >= 3 && ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/');
  const bool unc = path.size() > 4 && path[0] == L'\\' && path[1] == L'\\' && path[2] != L'.';
  if (!drive && !unc) return false;
  size_t begin = drive ? 3 : 2;
  while (begin <= path.size()) { const size_t end = path.find_first_of(L"\\/", begin); if (path.substr(begin, end == std::wstring::npos ? std::wstring::npos : end - begin) == L"..") return false; if (end == std::wstring::npos) break; begin = end + 1; }
  return true;
}
bool Paths(napi_env env, napi_value object, const char* name, bool empty, std::vector<std::wstring>* paths) {
  napi_value array; bool is_array = false; uint32_t count = 0;
  if (napi_get_named_property(env, object, name, &array) != napi_ok || napi_is_array(env, array, &is_array) != napi_ok || !is_array || napi_get_array_length(env, array, &count) != napi_ok || count > 1024 || (!empty && !count)) return false;
  paths->clear(); paths->reserve(count);
  for (uint32_t i = 0; i < count; ++i) { napi_value value; std::wstring path; if (napi_get_element(env, array, i, &value) != napi_ok || !String(env, value, 4096, &path) || !Absolute(path)) return false; std::replace(path.begin(), path.end(), L'\\', L'/'); if (std::find_if(paths->begin(), paths->end(), [&](const auto& item) { return CompareStringOrdinal(item.data(), static_cast<int>(item.size()), path.data(), static_cast<int>(path.size()), TRUE) == CSTR_EQUAL; }) == paths->end()) paths->push_back(std::move(path)); }
  return empty || !paths->empty();
}
bool Parse(napi_env env, const char* operation, napi_value object, Request* request) {
  napi_valuetype type; napi_value null_value; bool is_null = false;
  if (napi_typeof(env, object, &type) != napi_ok || type != napi_object || napi_get_null(env, &null_value) != napi_ok || napi_strict_equals(env, object, null_value, &is_null) != napi_ok || is_null) return false;
  if (!std::strcmp(operation, "clipboard.readFiles")) { request->operation = Operation::Read; return true; }
  if (!std::strcmp(operation, "clipboard.writeFiles")) { request->operation = Operation::Write; return Paths(env, object, "paths", false, &request->paths) && Field(env, object, "mode", 8, &request->mode) && (request->mode == L"copy" || request->mode == L"move"); }
  if (!std::strcmp(operation, "clipboard.acknowledge")) { request->operation = Operation::Acknowledge; return Field(env, object, "token", 512, &request->token) && !request->token.empty() && Field(env, object, "mode", 8, &request->mode) && (request->mode == L"copy" || request->mode == L"move") && Paths(env, object, "paths", false, &request->paths) && Paths(env, object, "remainingPaths", true, &request->remaining); }
  return false;
}

class ClipboardOperationGate final {
 public:
  bool BeginPublication() { long expected = 0; return state_.compare_exchange_strong(expected, 2); }
  void EndPublication() { long expected = 2; (void)state_.compare_exchange_strong(expected, 0); }
  void Close() { state_.exchange(1); }
  bool IsClosed() const { return state_.load() == 1; }
 private:
  std::atomic<long> state_{0};
};

class Publication final {
 public:
  Publication(std::shared_ptr<SessionState> state, std::shared_ptr<ClipboardOperationGate> gate)
      : state_(std::move(state)), gate_(std::move(gate)), active_(!state_->closed.load() && gate_->BeginPublication()) {
    if (active_ && state_->closed.load()) { gate_->Close(); active_ = false; }
  }
  ~Publication() { if (active_) gate_->EndPublication(); }
  explicit operator bool() const { return active_; }
 private:
  std::shared_ptr<SessionState> state_;
  std::shared_ptr<ClipboardOperationGate> gate_;
  bool active_;
};

class SystemBackend final : public ClipboardBackend {
 public:
  SystemBackend(HWND owner, std::shared_ptr<SessionState> state, std::shared_ptr<ClipboardOperationGate> gate)
      : owner_(owner), state_(std::move(state)), gate_(std::move(gate)) {}
  bool IsClosed() const override { return state_->closed.load() || gate_->IsClosed(); }
  DWORD Sequence() override { return GetClipboardSequenceNumber(); }
  HRESULT GetDataObject(IDataObject** object) override { return OleGetClipboard(object); }
  HRESULT GetIdentity(const std::wstring& value, ClipboardFileIdentity* identity) override {
    std::wstring path = value; std::replace(path.begin(), path.end(), L'/', L'\\');
    HANDLE file = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file == INVALID_HANDLE_VALUE) return HRESULT_FROM_WIN32(GetLastError());
    FILE_ID_INFO info{}; BY_HANDLE_FILE_INFORMATION basic{};
    const BOOL id_ok = GetFileInformationByHandleEx(file, FileIdInfo, &info, sizeof(info)); const DWORD id_error = id_ok ? ERROR_SUCCESS : GetLastError();
    const BOOL basic_ok = GetFileInformationByHandle(file, &basic); const DWORD basic_error = basic_ok ? ERROR_SUCCESS : GetLastError(); CloseHandle(file);
    if (!id_ok) return HRESULT_FROM_WIN32(id_error); if (!basic_ok) return HRESULT_FROM_WIN32(basic_error);
    identity->volume = info.VolumeSerialNumber; identity->id = info.FileId; identity->directory = (basic.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0; return S_OK;
  }
  HRESULT Replace(const std::vector<std::wstring>& paths, const std::wstring& mode, bool check, DWORD expected) override {
    HGLOBAL drop = nullptr, effect = nullptr;
    if (!paths.empty()) {
      std::vector<wchar_t> names;
      for (const auto& item : paths) { std::wstring path = item; std::replace(path.begin(), path.end(), L'/', L'\\'); names.insert(names.end(), path.begin(), path.end()); names.push_back(L'\0'); }
      names.push_back(L'\0'); const size_t size = sizeof(DROPFILES) + names.size() * sizeof(wchar_t);
      drop = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, size); if (!drop) return HRESULT_FROM_WIN32(GetLastError());
      void* memory = GlobalLock(drop); if (!memory) { const DWORD e = GetLastError(); GlobalFree(drop); return HRESULT_FROM_WIN32(e); }
      auto* header = static_cast<DROPFILES*>(memory); header->pFiles = sizeof(DROPFILES); header->fWide = TRUE; std::memcpy(static_cast<BYTE*>(memory) + sizeof(DROPFILES), names.data(), names.size() * sizeof(wchar_t)); GlobalUnlock(drop);
      const DWORD preferred = mode == L"move" ? DROPEFFECT_MOVE : DROPEFFECT_COPY; effect = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, sizeof(preferred));
      if (!effect) { const DWORD e = GetLastError(); GlobalFree(drop); return HRESULT_FROM_WIN32(e); }
      memory = GlobalLock(effect); if (!memory) { const DWORD e = GetLastError(); GlobalFree(effect); GlobalFree(drop); return HRESULT_FROM_WIN32(e); } std::memcpy(memory, &preferred, sizeof(preferred)); GlobalUnlock(effect);
    }
    if (IsClosed()) { if (drop) GlobalFree(drop); if (effect) GlobalFree(effect); return HRESULT_FROM_WIN32(ERROR_CANCELLED); }
    Publication publication(state_, gate_);
    if (!publication) { if (drop) GlobalFree(drop); if (effect) GlobalFree(effect); return HRESULT_FROM_WIN32(ERROR_CANCELLED); }
    if (!OpenClipboard(owner_)) { const DWORD e = GetLastError(); if (drop) GlobalFree(drop); if (effect) GlobalFree(effect); return HRESULT_FROM_WIN32(e); }
    HRESULT result = S_OK;
    if (check && GetClipboardSequenceNumber() != expected) result = HRESULT_FROM_WIN32(ERROR_RETRY);
    else if (!EmptyClipboard()) result = HRESULT_FROM_WIN32(GetLastError());
    else if (drop && !SetClipboardData(CF_HDROP, drop)) result = HRESULT_FROM_WIN32(GetLastError());
    else if (drop) { drop = nullptr; const UINT format = RegisterClipboardFormatW(L"Preferred DropEffect"); if (!format || !SetClipboardData(format, effect)) result = HRESULT_FROM_WIN32(GetLastError()); else effect = nullptr; }
    CloseClipboard(); if (drop) GlobalFree(drop); if (effect) GlobalFree(effect); return result;
  }
 private: HWND owner_;
  std::shared_ptr<SessionState> state_;
  std::shared_ptr<ClipboardOperationGate> gate_;
};

class StaSession;
class CompletionChannel final {
 public:
  explicit CompletionChannel(napi_threadsafe_function value) : value_(value) {}
  void Deliver() {
    napi_threadsafe_function value = nullptr;
    { std::lock_guard<std::mutex> lock(mutex_); value = std::exchange(value_, nullptr); }
    if (value) {
      (void)napi_call_threadsafe_function(value, nullptr, napi_tsfn_nonblocking);
      (void)napi_release_threadsafe_function(value, napi_tsfn_release);
    }
  }
  void Abort() {
    napi_threadsafe_function value = nullptr;
    { std::lock_guard<std::mutex> lock(mutex_); value = std::exchange(value_, nullptr); }
    if (value) (void)napi_release_threadsafe_function(value, napi_tsfn_abort);
  }
 private:
  std::mutex mutex_;
  napi_threadsafe_function value_ = nullptr;
};
struct Job {
  std::shared_ptr<SessionState> state;
  std::shared_ptr<StaSession> context;
  Request request;
  Result result;
  std::shared_ptr<CompletionChannel> completion;
  napi_deferred deferred = nullptr;
  std::mutex result_mutex;
  std::string operation;
};
using JobHandle = std::shared_ptr<Job>;
void CompleteTSFN(napi_env env, napi_value callback, void* context, void* data);
void FinalizeTSFN(napi_env env, void* data, void* hint);
struct Call { Request request; Result result; JobHandle job; std::mutex mutex; std::condition_variable ready; bool done = false; };
class StaSession final : public std::enable_shared_from_this<StaSession> {
 public:
  using BackendFactory = std::unique_ptr<ClipboardBackend>(*)(const std::shared_ptr<SessionState>&);
  explicit StaSession(std::shared_ptr<SessionState> state = {}, BackendFactory factory = nullptr)
      : state_(state ? std::move(state) : std::make_shared<SessionState>()), gate_(std::make_shared<ClipboardOperationGate>()),
        backend_factory_(factory), joined_(joined_promise_.get_future().share()) {}
  ~StaSession() { Close(); Join(); }
  Result Invoke(const Request& request) {
    Result failure; if (!Start()) { failure.status = init_status_; return failure; }
    auto call = std::make_shared<Call>(); call->request = request;
    { std::lock_guard<std::mutex> lock(queue_mutex_); if (closing_) { failure.status = HRESULT_FROM_WIN32(ERROR_CANCELLED); return failure; } queue_.push_back(call); }
    if (!PostThreadMessageW(thread_id_.load(), kWorkMessage, 0, 0)) {
      const HRESULT error = HRESULT_FROM_WIN32(GetLastError());
      bool removed = false;
      { std::lock_guard<std::mutex> lock(queue_mutex_); auto it = std::find(queue_.begin(), queue_.end(), call); if (it != queue_.end()) { queue_.erase(it); removed = true; } }
      if (removed) {
        { std::lock_guard<std::mutex> lock(call->mutex); call->result.status = error; call->done = true; }
        call->ready.notify_one();
      }
    }
    std::unique_lock<std::mutex> lock(call->mutex); call->ready.wait(lock, [&] { return call->done; }); return std::move(call->result);
  }
  bool Enqueue(const JobHandle& job) {
    Result failure; if (!Start()) { job->result.status = init_status_; return false; }
    auto call = std::make_shared<Call>(); call->request = job->request; call->job = job;
    { std::lock_guard<std::mutex> lock(queue_mutex_); if (closing_) { job->result.status = HRESULT_FROM_WIN32(ERROR_CANCELLED); return false; } completions_.erase(std::remove_if(completions_.begin(), completions_.end(), [](const auto& value) { return value.expired(); }), completions_.end()); completions_.push_back(job->completion); queue_.push_back(call); }
    if (!PostThreadMessageW(thread_id_.load(), kWorkMessage, 0, 0)) {
      job->result.status = HRESULT_FROM_WIN32(GetLastError());
      { std::lock_guard<std::mutex> lock(queue_mutex_); auto it = std::find(queue_.begin(), queue_.end(), call); if (it != queue_.end()) queue_.erase(it); }
      return false;
    }
    return true;
  }
  void Close() {
    if (!closing_.exchange(true)) {
      gate_->Close();
      state_->closed.store(true);
      const DWORD id = thread_id_.load();
      if (id) { (void)CoCancelCall(id, 0); PostThreadMessageW(id, WM_QUIT, 0, 0); }
    }
  }
  void AbortCallbacks() {
    std::vector<std::shared_ptr<CompletionChannel>> channels;
    { std::lock_guard<std::mutex> lock(queue_mutex_); for (auto& weak : completions_) if (auto channel = weak.lock()) channels.push_back(std::move(channel)); completions_.clear(); }
    for (const auto& channel : channels) channel->Abort();
  }
  void RegisterCompletion(const std::shared_ptr<CompletionChannel>& channel) {
    std::lock_guard<std::mutex> lock(queue_mutex_);
    completions_.push_back(channel);
  }
  void Join() { std::lock_guard<std::mutex> lock(start_mutex_); if (thread_.joinable()) thread_.join(); }
  void RetainUntilJoined() { std::lock_guard<std::mutex> lock(lifetime_mutex_); self_keepalive_ = shared_from_this(); }
  void Joined() { bool expected = false; if (joined_set_.compare_exchange_strong(expected, true)) joined_promise_.set_value(); std::lock_guard<std::mutex> lock(lifetime_mutex_); self_keepalive_.reset(); }
  std::shared_future<void> JoinedFuture() const { return joined_; }
 private:
  bool Start() {
    std::unique_lock<std::mutex> start_lock(start_mutex_);
    if (thread_.joinable()) { std::unique_lock<std::mutex> lock(init_mutex_); init_ready_.wait(lock, [&] { return initialized_; }); return SUCCEEDED(init_status_); }
    if (closing_) { init_status_ = HRESULT_FROM_WIN32(ERROR_CANCELLED); return false; }
    if (!PinModuleForAsyncWork()) { init_status_ = HRESULT_FROM_WIN32(GetLastError()); return false; }
    try { thread_ = std::thread([this] { Run(); }); } catch (...) { init_status_ = E_OUTOFMEMORY; return false; }
    std::unique_lock<std::mutex> lock(init_mutex_); init_ready_.wait(lock, [&] { return initialized_; }); return SUCCEEDED(init_status_);
  }
  void Finish(const std::shared_ptr<Call>& call, Result result) {
    if (call->job) {
      { std::lock_guard<std::mutex> lock(call->job->result_mutex); call->job->result = std::move(result); }
      if (call->job->completion) call->job->completion->Deliver();
      return;
    }
    { std::lock_guard<std::mutex> lock(call->mutex); call->result = std::move(result); call->done = true; } call->ready.notify_one();
  }
  void Drain(ClipboardOleEngine* engine) {
    for (;;) {
      std::shared_ptr<Call> call; { std::lock_guard<std::mutex> lock(queue_mutex_); if (queue_.empty()) return; call = std::move(queue_.front()); queue_.erase(queue_.begin()); }
      Result result;
      if (closing_) result.status = HRESULT_FROM_WIN32(ERROR_CANCELLED);
      else try {
        HRESULT hr = E_INVALIDARG; ClipboardSelection selection; bool matched = false;
        if (call->request.operation == Operation::Read) { hr = engine->Read(&selection); if (SUCCEEDED(hr)) { result.paths = std::move(selection.paths); result.mode = std::move(selection.mode); result.token = std::move(selection.token); } }
        else if (call->request.operation == Operation::Write) { hr = engine->Write(call->request.paths, call->request.mode, &selection); if (SUCCEEDED(hr)) { result.paths = std::move(selection.paths); result.mode = std::move(selection.mode); result.token = std::move(selection.token); } }
        else hr = engine->Acknowledge(call->request.token, call->request.paths, call->request.mode, call->request.remaining, &matched, &result.errors);
        result.matched = matched; result.status = hr;
      } catch (...) { result.status = E_OUTOFMEMORY; }
      Finish(call, std::move(result));
    }
  }
  void Run() {
    const HRESULT ole = OleInitialize(nullptr); HRESULT status = ole; HWND owner = nullptr; bool cancellation_enabled = false;
    if (SUCCEEDED(ole)) cancellation_enabled = SUCCEEDED(CoEnableCallCancellation(nullptr));
    if (SUCCEEDED(ole)) { MSG init{}; PeekMessageW(&init, nullptr, WM_USER, WM_USER, PM_NOREMOVE); owner = CreateWindowExW(0, L"STATIC", L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, GetModuleHandleW(nullptr), nullptr); if (!owner) status = HRESULT_FROM_WIN32(GetLastError()); }
    { std::lock_guard<std::mutex> lock(init_mutex_); init_status_ = status; thread_id_.store(GetCurrentThreadId()); initialized_ = true; } init_ready_.notify_all();
    if (closing_.load()) PostThreadMessageW(thread_id_.load(), WM_QUIT, 0, 0);
    if (FAILED(status)) { if (SUCCEEDED(ole)) OleUninitialize(); return; }
    std::unique_ptr<ClipboardBackend> backend = backend_factory_ ? backend_factory_(state_) : std::make_unique<SystemBackend>(owner, state_, gate_);
    ClipboardOleEngine engine(backend.get()); MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) { if (message.message == kWorkMessage) Drain(&engine); else { TranslateMessage(&message); DispatchMessageW(&message); } }
    closing_.store(true);
    Drain(&engine);
    engine.Reset(); DestroyWindow(owner);
    if (cancellation_enabled) CoDisableCallCancellation(nullptr);
    OleUninitialize();
  }
  std::shared_ptr<SessionState> state_; std::shared_ptr<ClipboardOperationGate> gate_; BackendFactory backend_factory_ = nullptr; std::mutex start_mutex_, init_mutex_, queue_mutex_, lifetime_mutex_; std::condition_variable init_ready_; bool initialized_ = false; HRESULT init_status_ = E_PENDING; std::atomic<DWORD> thread_id_{0}; std::vector<std::shared_ptr<Call>> queue_; std::vector<std::weak_ptr<CompletionChannel>> completions_; std::thread thread_; std::atomic<bool> closing_{false}; std::promise<void> joined_promise_; std::shared_future<void> joined_; std::atomic<bool> joined_set_{false}; std::shared_ptr<StaSession> self_keepalive_;
};

class ContextReaper final {
  struct JoinRequest { std::shared_ptr<StaSession> context; std::shared_ptr<CompletionChannel> completion; };
 public:
  void Enqueue(const std::shared_ptr<StaSession>& context, const std::shared_ptr<CompletionChannel>& completion = {}) {
    context->RetainUntilJoined();
    auto* retained = new (std::nothrow) JoinRequest{context, completion};
    if (!retained) return;
    if (QueueUserWorkItem(&Run, retained, WT_EXECUTEDEFAULT)) return;
    if (TrySubmitThreadpoolCallback(&RunThreadpool, retained, nullptr)) return;
    (void)retained;
  }
  void Shutdown() {}
 private:
  static DWORD WINAPI Run(void* value) {
    std::unique_ptr<JoinRequest> retained(static_cast<JoinRequest*>(value));
    retained->context->Join();
    retained->context->Joined();
    if (retained->completion) retained->completion->Deliver();
    return 0;
  }
  static void CALLBACK RunThreadpool(PTP_CALLBACK_INSTANCE, void* value) { (void)Run(value); }
};

using ContextMap = std::map<std::weak_ptr<SessionState>, std::shared_ptr<StaSession>, std::owner_less<std::weak_ptr<SessionState>>>;
std::mutex contexts_mutex; std::map<napi_env, ContextMap> contexts; std::map<napi_env, std::shared_ptr<ContextReaper>> reapers; std::map<napi_env, std::vector<std::weak_ptr<CompletionChannel>>> env_completions; std::map<napi_env, bool> hooks;
void Cleanup(void* data) { auto env = static_cast<napi_env>(data); std::vector<std::shared_ptr<StaSession>> all; std::vector<std::shared_ptr<CompletionChannel>> channels; std::shared_ptr<ContextReaper> reaper; { std::lock_guard<std::mutex> lock(contexts_mutex); auto it = contexts.find(env); if (it != contexts.end()) { for (auto& item : it->second) all.push_back(std::move(item.second)); contexts.erase(it); } auto r = reapers.find(env); if (r != reapers.end()) { reaper = std::move(r->second); reapers.erase(r); } auto c = env_completions.find(env); if (c != env_completions.end()) { for (auto& weak : c->second) if (auto channel = weak.lock()) channels.push_back(std::move(channel)); env_completions.erase(c); } hooks.erase(env); } for (const auto& channel : channels) channel->Abort(); if (!reaper) { try { reaper = std::make_shared<ContextReaper>(); } catch (...) {} } for (auto& item : all) { item->AbortCallbacks(); item->Close(); if (reaper) reaper->Enqueue(item); else item->RetainUntilJoined(); } if (reaper) reaper->Shutdown(); }
bool EnsureHook(napi_env env) { std::lock_guard<std::mutex> lock(contexts_mutex); if (hooks.count(env)) return true; if (napi_add_env_cleanup_hook(env, Cleanup, env) != napi_ok) return false; hooks.emplace(env, true); return true; }
void RegisterEnvCompletion(napi_env env, const std::shared_ptr<CompletionChannel>& channel) { std::lock_guard<std::mutex> lock(contexts_mutex); auto& channels = env_completions[env]; channels.erase(std::remove_if(channels.begin(), channels.end(), [](const auto& value) { return value.expired(); }), channels.end()); channels.push_back(channel); }
std::shared_ptr<StaSession> GetContext(napi_env env, const std::shared_ptr<SessionState>& state, StaSession::BackendFactory factory = nullptr) { std::lock_guard<std::mutex> lock(contexts_mutex); auto& map = contexts[env]; if (!reapers.count(env)) reapers.emplace(env, std::make_shared<ContextReaper>()); std::weak_ptr<SessionState> key(state); auto it = map.find(key); if (it != map.end()) return it->second; auto context = std::make_shared<StaSession>(state, factory); map.emplace(key, context); return context; }
const char* ErrorCode(HRESULT hr) { if (hr == HRESULT_FROM_WIN32(ERROR_RETRY)) return "ClipboardChanged"; if (hr == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) || hr == HRESULT_FROM_WIN32(ERROR_PATH_NOT_FOUND)) return "ClipboardSourceChanged"; if (hr == HRESULT_FROM_WIN32(ERROR_CANCELLED)) return "SessionClosed"; if (hr == E_INVALIDARG || hr == DV_E_FORMATETC) return "InvalidRequest"; return "ClipboardNativeFailure"; }
napi_value Text(napi_env env, const std::string& value) { napi_value result; return napi_create_string_utf8(env, value.data(), value.size(), &result) == napi_ok ? result : nullptr; }
napi_value Wide(napi_env env, const std::wstring& value) { napi_value result; return napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(value.data()), value.size(), &result) == napi_ok ? result : nullptr; }
napi_value Outcome(napi_env env, const Job& job) {
  napi_value result; if (napi_create_object(env, &result) != napi_ok) return nullptr;
  if (job.request.operation == Operation::Acknowledge) { napi_value matched, errors; if (napi_get_boolean(env, job.result.matched, &matched) != napi_ok || napi_create_array_with_length(env, job.result.errors.size(), &errors) != napi_ok) return nullptr; for (uint32_t i = 0; i < job.result.errors.size(); ++i) { napi_value value = Text(env, job.result.errors[i]); if (!value || napi_set_element(env, errors, i, value) != napi_ok) return nullptr; } if (napi_set_named_property(env, result, "matched", matched) != napi_ok || napi_set_named_property(env, result, "notificationErrors", errors) != napi_ok) return nullptr; return result; }
  napi_value paths; if (napi_create_array_with_length(env, job.result.paths.size(), &paths) != napi_ok) return nullptr; for (uint32_t i = 0; i < job.result.paths.size(); ++i) { napi_value value = Wide(env, job.result.paths[i]); if (!value || napi_set_element(env, paths, i, value) != napi_ok) return nullptr; } napi_value mode = Wide(env, job.result.mode), token = Wide(env, job.result.token); if (!mode || !token || napi_set_named_property(env, result, "paths", paths) != napi_ok || napi_set_named_property(env, result, "mode", mode) != napi_ok || napi_set_named_property(env, result, "token", token) != napi_ok) return nullptr; return result;
}
void FinalizeTSFN(napi_env, void* data, void*) { delete static_cast<JobHandle*>(data); }
void CompleteTSFN(napi_env env, napi_value, void* context, void*) {
  if (!env || !context) return;
  auto* owner = static_cast<JobHandle*>(context);
  Job& job = **owner;
  std::lock_guard<std::mutex> lock(job.result_mutex);
  const HRESULT result_status = job.result.status;
  const char* code = job.state->closed.load() ? "SessionClosed" : FAILED(result_status) ? ErrorCode(result_status) : nullptr;
  if (code) {
    napi_value error, native, message = Text(env, "Windows file clipboard operation failed.");
    if (napi_create_error(env, Text(env, code), message, &error) != napi_ok) return;
    napi_create_int32(env, result_status, &native);
    napi_set_named_property(env, error, "nativeCode", native);
    napi_set_named_property(env, error, "operation", Text(env, job.operation));
    napi_reject_deferred(env, job.deferred, error);
    return;
  }
  napi_value value = Outcome(env, job);
  if (value) napi_resolve_deferred(env, job.deferred, value);
}
}

#ifdef CLIPBOARD_TESTING
bool VerifyWindowsClipboardStaLifecycleForTest() {
  auto factory = [](const std::shared_ptr<SessionState>& state) -> std::unique_ptr<ClipboardBackend> { return std::make_unique<ClipboardTestBackend>(state); };
  auto context = std::make_shared<StaSession>(std::make_shared<SessionState>(), factory);
  Request read; read.operation = Operation::Read;
  Result selection = context->Invoke(read);
  if (FAILED(selection.status) || selection.paths.size() != 2 || selection.mode != L"move" || selection.token.empty()) return false;
  Request ack; ack.operation = Operation::Acknowledge; ack.token = selection.token; ack.mode = selection.mode;
  ack.paths = selection.paths; ack.remaining = {L"C:/tmp/remaining.txt"};
  Result acknowledged = context->Invoke(ack);
  if (FAILED(acknowledged.status) || !acknowledged.matched) return false;
  context->Close();
  const auto closed = context->JoinedFuture();
  ContextReaper reaper; reaper.Enqueue(context); reaper.Shutdown();
  return closed.wait_for(std::chrono::seconds(5)) == std::future_status::ready;
}
#endif

bool IsWindowsClipboardOperation(const char* operation) { return !std::strcmp(operation, "clipboard.readFiles") || !std::strcmp(operation, "clipboard.writeFiles") || !std::strcmp(operation, "clipboard.acknowledge"); }
napi_value StartClipboardQuery(napi_env env, const std::shared_ptr<SessionState>& state, const char* operation,
                               napi_value request, StaSession::BackendFactory factory) {
  auto job = std::make_shared<Job>(); job->state = state; job->operation = operation;
  if (!Parse(env, operation, request, &job->request)) return Fail(env, "InvalidRequest", "Invalid native file clipboard request.");
  if (!EnsureHook(env)) return Fail(env, "BindingFailure", "Cannot register native clipboard cleanup.");
  job->context = GetContext(env, state, factory); napi_value promise;
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok) return Fail(env, "BindingFailure", "Cannot create native file clipboard promise.");
  auto* owner = new (std::nothrow) JobHandle(job);
  if (!owner) return Fail(env, "BindingFailure", "Cannot allocate native file clipboard completion state.");
  napi_value resource_name = Text(env, job->operation);
  napi_threadsafe_function completion = nullptr;
  const napi_status created = napi_create_threadsafe_function(env, nullptr, nullptr, resource_name, 0, 1,
      owner, FinalizeTSFN, owner, CompleteTSFN, &completion);
  if (created != napi_ok) { delete owner; return Fail(env, "BindingFailure", "Cannot create native file clipboard completion channel."); }
  try { job->completion = std::make_shared<CompletionChannel>(completion); }
  catch (...) { (void)napi_release_threadsafe_function(completion, napi_tsfn_abort); return Fail(env, "BindingFailure", "Cannot allocate native file clipboard completion channel."); }
  RegisterEnvCompletion(env, job->completion);
  if (!job->context->Enqueue(job)) {
    { std::lock_guard<std::mutex> lock(job->result_mutex); if (SUCCEEDED(job->result.status)) job->result.status = HRESULT_FROM_WIN32(ERROR_CANCELLED); }
    job->completion->Deliver();
  }
  return promise;
}
napi_value StartWindowsClipboardQuery(napi_env env, const std::shared_ptr<SessionState>& state, const char* operation, napi_value request) {
  return StartClipboardQuery(env, state, operation, request, nullptr);
}
#ifdef CLIPBOARD_TESTING
namespace {
std::mutex clipboard_test_states_mutex;
std::vector<std::shared_ptr<SessionState>> clipboard_test_states;
}
napi_value StartWindowsClipboardBlockedOwnerTest(napi_env env) {
  if (!CurrentClipboardTestOwnerGate()) PrepareWindowsClipboardTestOwners(1);
  auto state = std::make_shared<SessionState>();
  { std::lock_guard<std::mutex> lock(clipboard_test_states_mutex); clipboard_test_states.push_back(state); }
  auto factory = [](const std::shared_ptr<SessionState>& value) -> std::unique_ptr<ClipboardBackend> {
    return std::make_unique<ClipboardTestBackend>(value);
  };
  napi_value request;
  if (napi_create_object(env, &request) != napi_ok) return Fail(env, "BindingFailure", "Cannot create fake owner request.");
  return StartClipboardQuery(env, state, "clipboard.readFiles", request, factory);
}
void PrepareWindowsClipboardTestOwners(uint32_t count) {
  auto gate = std::make_shared<ClipboardTestOwnerGate>();
  gate->required = std::max(1u, count);
  SetClipboardTestOwnerGate(std::move(gate));
  std::lock_guard<std::mutex> lock(clipboard_test_states_mutex);
  clipboard_test_states.clear();
}
bool WaitWindowsClipboardTestOwners(uint32_t milliseconds) {
  auto gate = CurrentClipboardTestOwnerGate();
  return gate && gate->entered && WaitForSingleObject(gate->entered, milliseconds) == WAIT_OBJECT_0;
}
 napi_value CloseWindowsClipboardTestOwner(napi_env env, uint32_t index) {
  std::shared_ptr<SessionState> state;
  { std::lock_guard<std::mutex> lock(clipboard_test_states_mutex); if (index >= clipboard_test_states.size()) return Fail(env, "InvalidRequest", "Unknown fake owner session."); state = clipboard_test_states[index]; }
  state->closed.store(true);
  return CloseWindowsClipboardSessionAsync(env, state);
}
void ReleaseWindowsClipboardTestOwner() {
  auto gate = CurrentClipboardTestOwnerGate();
  if (gate && gate->release) SetEvent(gate->release);
}
#endif
struct StoppedSession { std::shared_ptr<StaSession> context; std::shared_ptr<ContextReaper> reaper; };
StoppedSession TakeClipboardSession(const std::shared_ptr<SessionState>& state) {
  StoppedSession stopped;
  {
    std::lock_guard<std::mutex> lock(contexts_mutex); std::weak_ptr<SessionState> key(state);
    for (auto& by_env : contexts) { auto it = by_env.second.find(key); if (it == by_env.second.end()) continue; stopped.context = it->second; by_env.second.erase(it); auto found = reapers.find(by_env.first); if (found != reapers.end()) stopped.reaper = found->second; break; }
  }
  return stopped;
}
void QueueClipboardJoin(const StoppedSession& stopped, const std::shared_ptr<CompletionChannel>& completion = {}) {
  if (!stopped.context) { if (completion) completion->Deliver(); return; }
  stopped.context->Close();
  if (completion) stopped.context->RegisterCompletion(completion);
  if (stopped.reaper) stopped.reaper->Enqueue(stopped.context, completion);
  else { try { std::make_shared<ContextReaper>()->Enqueue(stopped.context, completion); } catch (...) { stopped.context->RetainUntilJoined(); } }
}

struct CloseCompletion { napi_deferred deferred = nullptr; std::shared_ptr<CompletionChannel> channel; };
void FinalizeCloseTSFN(napi_env, void* data, void*) { delete static_cast<std::shared_ptr<CloseCompletion>*>(data); }
void CompleteCloseTSFN(napi_env env, napi_value, void* context, void*) {
  if (!env || !context) return;
  const auto& completion = *static_cast<std::shared_ptr<CloseCompletion>*>(context);
  napi_value undefined;
  if (napi_get_undefined(env, &undefined) == napi_ok) napi_resolve_deferred(env, completion->deferred, undefined);
}

void CloseWindowsClipboardSession(const std::shared_ptr<SessionState>& state) { QueueClipboardJoin(TakeClipboardSession(state)); }
napi_value CloseWindowsClipboardSessionAsync(napi_env env, const std::shared_ptr<SessionState>& state) {
  if (!EnsureHook(env)) return Fail(env, "BindingFailure", "Cannot register native clipboard cleanup.");
  napi_deferred deferred; napi_value promise;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) return Fail(env, "BindingFailure", "Cannot create native clipboard close promise.");
  auto completion = std::make_shared<CloseCompletion>(); completion->deferred = deferred;
  auto* owner = new (std::nothrow) std::shared_ptr<CloseCompletion>(completion);
  if (!owner) return Fail(env, "BindingFailure", "Cannot allocate native clipboard close completion state.");
  napi_value resource_name = Text(env, "clipboard.close");
  napi_threadsafe_function callback = nullptr;
  const napi_status created = napi_create_threadsafe_function(env, nullptr, nullptr, resource_name, 0, 1,
      owner, FinalizeCloseTSFN, owner, CompleteCloseTSFN, &callback);
  if (created != napi_ok) { delete owner; return Fail(env, "BindingFailure", "Cannot create native clipboard close completion channel."); }
  try { completion->channel = std::make_shared<CompletionChannel>(callback); }
  catch (...) { (void)napi_release_threadsafe_function(callback, napi_tsfn_abort); return Fail(env, "BindingFailure", "Cannot allocate native clipboard close completion channel."); }
  RegisterEnvCompletion(env, completion->channel);
  QueueClipboardJoin(TakeClipboardSession(state), completion->channel);
  return promise;
}

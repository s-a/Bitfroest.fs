#include "binding-transfer-win.h"
#include "file-transfer-win.h"
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <atomic>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <utility>

namespace {
struct ProgressChannel {
  std::mutex mutex;
  std::optional<FileTransferProgress> latest;
  bool queued = false;
  std::atomic<bool> closing{false};
};
struct CopyJob {
  std::atomic<size_t> references{1};
  std::shared_ptr<SessionState> state;
  std::shared_ptr<FileTransferSession> session;
  FileTransferRequest request;
  FileTransferResult result;
  uint64_t io_ticket = 0;
  std::shared_ptr<std::atomic<bool>> cancelled = std::make_shared<std::atomic<bool>>(false);
  std::shared_ptr<std::atomic<bool>> finished = std::make_shared<std::atomic<bool>>(false);
  std::atomic<bool> copy_entered{false};
  std::atomic<bool> finish_called{false};
  std::shared_ptr<ProgressChannel> progress_channel = std::make_shared<ProgressChannel>();
  napi_threadsafe_function progress = nullptr;
  napi_threadsafe_function completion = nullptr;
  napi_deferred deferred = nullptr;
};
struct CopyShutdown {
  std::atomic<size_t> references{1};
  std::shared_ptr<FileTransferSession> session;
  napi_threadsafe_function completion = nullptr;
  napi_deferred deferred = nullptr;
  bool failed = false;
};
void RetainCopyJob(CopyJob* job) { job->references.fetch_add(1); }
void ReleaseCopyJob(CopyJob* job) { if (job->references.fetch_sub(1) == 1) delete job; }
void RetainCopyShutdown(CopyShutdown* cleanup) { cleanup->references.fetch_add(1); }
void ReleaseCopyShutdown(CopyShutdown* cleanup) { if (cleanup->references.fetch_sub(1) == 1) delete cleanup; }
void ReleaseFunctionOnce(napi_threadsafe_function function) {
  if (function) napi_release_threadsafe_function(function, napi_tsfn_abort);
}
void ReleaseUnstartedFunction(napi_threadsafe_function function) {
  if (!function) return;
  napi_release_threadsafe_function(function, napi_tsfn_abort);
  napi_release_threadsafe_function(function, napi_tsfn_abort);
}
struct Cancellation {
  std::shared_ptr<std::atomic<bool>> requested;
  std::shared_ptr<std::atomic<bool>> finished;
  std::shared_ptr<FileTransferSession> session;
};
struct IoCancellation {
  std::shared_ptr<std::atomic<bool>> finished;
  std::shared_ptr<FileTransferSession> session;
  uint64_t ticket = 0;
};
uint64_t NextCopyTicket() {
  static std::atomic<uint64_t> next{1};
  uint64_t ticket = next.fetch_add(1, std::memory_order_relaxed);
  if (!ticket) ticket = next.fetch_add(1, std::memory_order_relaxed);
  return ticket;
}
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
napi_value Fail(napi_env env, const char* code, const char* message) { napi_throw_error(env, code, message); return nullptr; }
#define CHECK(call) do { if ((call) != napi_ok) return Fail(env, "BindingFailure", "Native copy binding failed."); } while (false)
napi_value Text(napi_env env, const std::string& value) {
  napi_value result;
  CHECK(napi_create_string_utf8(env, value.data(), value.size(), &result));
  return result;
}
bool Object(napi_env env, napi_value value) {
  napi_valuetype type;
  napi_value null_value;
  bool is_null;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_object && napi_get_null(env, &null_value) == napi_ok && napi_strict_equals(env, value, null_value, &is_null) == napi_ok && !is_null;
}
bool ReadString(napi_env env, napi_value value, size_t limit, std::wstring* result) {
  size_t length;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || length > limit) return false;
  std::vector<char16_t> buffer(length + 1);
  if (napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
  result->assign(buffer.begin(), buffer.begin() + length);
  return result->find(L'\0') == std::wstring::npos;
}
bool Field(napi_env env, napi_value object, const char* name, size_t limit, std::wstring* result) {
  napi_value value;
  return napi_get_named_property(env, object, name, &value) == napi_ok && ReadString(env, value, limit, result);
}
napi_value Identity(napi_env env, const FileTransferIdentity& identity) {
  napi_value result;
  CHECK(napi_create_object(env, &result));
  CHECK(napi_set_named_property(env, result, "dev", Text(env, identity.dev)));
  CHECK(napi_set_named_property(env, result, "ino", Text(env, identity.ino)));
  CHECK(napi_set_named_property(env, result, "size", Text(env, identity.size)));
  CHECK(napi_set_named_property(env, result, "mtimeNs", Text(env, identity.mtime_ns)));
  CHECK(napi_set_named_property(env, result, "ctimeNs", Text(env, identity.ctime_ns)));
  return result;
}
const char* Status(FileTransferStatus state) {
  switch (state) {
    case FileTransferStatus::kCommitted: return "committed";
    case FileTransferStatus::kUnchanged: return "unchanged";
    case FileTransferStatus::kPartial: return "partial";
    default: return "unknown";
  }
}
napi_value Outcome(napi_env env, const CopyJob& job) {
  napi_value result, copied, cancelled;
  CHECK(napi_create_object(env, &result));
  CHECK(napi_get_boolean(env, job.result.status == FileTransferStatus::kCommitted, &copied));
  CHECK(napi_get_boolean(env, job.result.cancelled, &cancelled));
  CHECK(napi_set_named_property(env, result, "status", Text(env, Status(job.result.status))));
  CHECK(napi_set_named_property(env, result, "copied", copied));
  CHECK(napi_set_named_property(env, result, "cancelled", cancelled));
  if (job.result.owned_destination) CHECK(napi_set_named_property(env, result, "ownedDestination", Identity(env, job.result.owned_destination->identity)));
  return result;
}
void FinishSessionCopy(CopyJob* job) {
  if (job->copy_entered.load() && !job->finish_called.exchange(true)) job->session->FinishCopy();
}
void Progress(napi_env env, napi_value callback, void* context, void*) {
  auto* channel = static_cast<ProgressChannel*>(context);
  if (!env || !callback || !channel) return;
  std::optional<FileTransferProgress> event;
  {
    std::lock_guard<std::mutex> lock(channel->mutex);
    event = std::move(channel->latest);
    channel->latest.reset();
    channel->queued = false;
  }
  if (!event) return;
  napi_value value, transferred, total, receiver, ignored;
  if (napi_create_object(env, &value) != napi_ok || napi_create_double(env, static_cast<double>(event->transferred), &transferred) != napi_ok || napi_create_double(env, static_cast<double>(event->total), &total) != napi_ok) return;
  napi_set_named_property(env, value, "transferred", transferred);
  napi_set_named_property(env, value, "total", total);
  if (event->owned_destination) napi_set_named_property(env, value, "ownedDestination", Identity(env, event->owned_destination->identity));
  napi_get_undefined(env, &receiver);
  if (napi_call_function(env, receiver, callback, 1, &value, &ignored) != napi_ok) {
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) napi_get_and_clear_last_exception(env, &ignored);
  }
}
void FinalizeProgress(napi_env, void* data, void*) {
  delete static_cast<std::shared_ptr<ProgressChannel>*>(data);
}
void QueueProgress(CopyJob* job, const FileTransferProgress& event) {
  if (!job->progress || job->progress_channel->closing.load() || event.transferred > 9007199254740991ULL || event.total > 9007199254740991ULL) return;
  bool schedule = false;
  {
    std::lock_guard<std::mutex> lock(job->progress_channel->mutex);
    if (job->progress_channel->closing.load()) return;
    job->progress_channel->latest = event;
    if (!job->progress_channel->queued) {
      job->progress_channel->queued = true;
      schedule = true;
    }
  }
  if (!schedule) return;
  const napi_status status = napi_call_threadsafe_function(job->progress, nullptr, napi_tsfn_nonblocking);
  if (status == napi_closing || (status != napi_ok && status != napi_queue_full)) {
    std::lock_guard<std::mutex> lock(job->progress_channel->mutex);
    job->progress_channel->closing.store(true);
    job->progress_channel->queued = false;
    job->progress_channel->latest.reset();
  }
}
void CALLBACK Execute(PTP_CALLBACK_INSTANCE, void* data) {
  auto* job = static_cast<CopyJob*>(data);
  try {
    job->copy_entered.store(job->session->Copy(job->request, [job] { return job->cancelled->load() || job->state->closed.load(); }, [job](const FileTransferProgress& event) {
      QueueProgress(job, event);
    }, &job->result, job->io_ticket));
  } catch (const std::bad_alloc&) { job->result.code = "ResourceExhausted"; job->result.status = FileTransferStatus::kUnknown; }
    catch (...) { job->result.code = "NativeFailure"; job->result.status = FileTransferStatus::kUnknown; }
  if (!job->copy_entered.load()) job->session->CancelQueuedCopy();
  job->finished->store(true);
  // Drain the latest queued progress item. Aborting here discards an event
  // already accepted by Node-API and can hide the final native progress.
  if (job->progress && !job->progress_channel->closing.load()) napi_release_threadsafe_function(job->progress, napi_tsfn_release);
  const napi_status queued = napi_call_threadsafe_function(job->completion, nullptr, napi_tsfn_nonblocking);
  if (queued != napi_ok) FinishSessionCopy(job);
  if (queued != napi_closing) napi_release_threadsafe_function(job->completion, napi_tsfn_release);
  ReleaseCopyJob(job);
}
void Complete(napi_env env, napi_value, void* context, void*) {
  auto* job = static_cast<CopyJob*>(context);
  if (!env) {
    FinishSessionCopy(job);
    return;
  }
  job->state->copy_busy = false;
  napi_value outcome = Outcome(env, *job);
  if (!outcome) { FinishSessionCopy(job); return; }
  const bool committed = job->result.status == FileTransferStatus::kCommitted;
  const char* code = job->state->closed ? "SessionClosed" : !committed ? (job->result.code.empty() ? "NativeFailure" : job->result.code.c_str()) : nullptr;
  if (code) {
    napi_value error, number;
    if (napi_create_error(env, Text(env, code), Text(env, job->result.message.empty() ? "Native copy failed." : job->result.message), &error) == napi_ok) {
      napi_create_uint32(env, job->result.native_error, &number);
      napi_set_named_property(env, error, "nativeCode", number);
      napi_set_named_property(env, error, "operation", Text(env, "files.copy"));
      napi_set_named_property(env, error, "outcome", outcome);
      if (job->result.owned_destination) napi_set_named_property(env, error, "ownedDestination", Identity(env, job->result.owned_destination->identity));
      napi_reject_deferred(env, job->deferred, error);
    }
  } else napi_resolve_deferred(env, job->deferred, outcome);
  FinishSessionCopy(job);
}
void FinalizeCopy(napi_env, void* data, void*) {
  auto* job = static_cast<CopyJob*>(data);
  FinishSessionCopy(job);
  ReleaseCopyJob(job);
}
napi_value Cancel(napi_env env, napi_callback_info info) {
  void* data;
  if (napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &data) != napi_ok) return Fail(env, "BindingFailure", "Cannot cancel native copy.");
  auto* cancellation = static_cast<Cancellation*>(data);
  cancellation->requested->store(true);
  if (!cancellation->finished->load()) cancellation->session->RequestCancel();
  napi_value result;
  CHECK(napi_get_undefined(env, &result));
  return result;
}
void DeleteCancel(napi_env, void* data, void*) { delete static_cast<Cancellation*>(data); }
napi_value CancelIo(napi_env env, napi_callback_info info) {
  void* data;
  if (napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &data) != napi_ok) return Fail(env, "BindingFailure", "Cannot cancel native copy I/O.");
  auto* cancellation = static_cast<IoCancellation*>(data);
  if (!cancellation->finished->load()) cancellation->session->RequestIoCancel(cancellation->ticket);
  napi_value result;
  CHECK(napi_get_undefined(env, &result));
  return result;
}
void DeleteCancelIo(napi_env, void* data, void*) { delete static_cast<IoCancellation*>(data); }
void CALLBACK AwaitShutdown(PTP_CALLBACK_INSTANCE, void* data) {
  auto* cleanup = static_cast<CopyShutdown*>(data);
  try { cleanup->session->AwaitStopped(); } catch (...) { cleanup->failed = true; }
  const napi_status queued = napi_call_threadsafe_function(cleanup->completion, nullptr, napi_tsfn_nonblocking);
  if (queued != napi_closing) napi_release_threadsafe_function(cleanup->completion, napi_tsfn_release);
  ReleaseCopyShutdown(cleanup);
}
void CompleteShutdown(napi_env env, napi_value, void* context, void*) {
  auto* cleanup = static_cast<CopyShutdown*>(context);
  if (!env) return;
  napi_value value;
  if (napi_get_undefined(env, &value) != napi_ok) return;
  if (cleanup->failed) {
    napi_value error;
    if (napi_create_error(env, Text(env, "NativeFailure"), Text(env, "Native copy shutdown failed."), &error) != napi_ok) return;
    napi_reject_deferred(env, cleanup->deferred, error);
  } else napi_resolve_deferred(env, cleanup->deferred, value);
}
void FinalizeShutdown(napi_env, void* data, void*) { ReleaseCopyShutdown(static_cast<CopyShutdown*>(data)); }
}

napi_value ShutdownNativeCopies(napi_env env, const std::shared_ptr<SessionState>& state) {
  if (state->copy_session && !PinModuleForAsyncWork()) return Fail(env, "NativeFailure", "Cannot retain the native module for copy shutdown.");
  auto cleanup = std::make_unique<CopyShutdown>();
  napi_value promise;
  CHECK(napi_create_promise(env, &cleanup->deferred, &promise));
  cleanup->session = state->copy_session;
  if (!cleanup->session) {
    napi_value value;
    CHECK(napi_get_undefined(env, &value));
    CHECK(napi_resolve_deferred(env, cleanup->deferred, value));
    return promise;
  }
  cleanup->session->Shutdown();
  auto* raw = cleanup.get();
  RetainCopyShutdown(raw);
  napi_value resource = Text(env, "files.copy.shutdown");
  if (!resource || napi_create_threadsafe_function(env, nullptr, nullptr, resource, 0, 1,
                                      raw, FinalizeShutdown, raw, CompleteShutdown, &raw->completion) != napi_ok) {
    ReleaseCopyShutdown(raw);
    return Fail(env, "BindingFailure", "Cannot create native copy shutdown completion.");
  }
  cleanup.release();
  ReleaseCopyShutdown(raw);
  if (napi_acquire_threadsafe_function(raw->completion) != napi_ok) {
    napi_release_threadsafe_function(raw->completion, napi_tsfn_abort);
    return Fail(env, "BindingFailure", "Cannot retain native copy shutdown completion.");
  }
  RetainCopyShutdown(raw);
  if (!TrySubmitThreadpoolCallback(AwaitShutdown, raw, nullptr)) {
    ReleaseCopyShutdown(raw);
    napi_release_threadsafe_function(raw->completion, napi_tsfn_abort);
    napi_release_threadsafe_function(raw->completion, napi_tsfn_abort);
    return Fail(env, "BindingFailure", "Cannot queue native copy shutdown.");
  }
  state->copy_session.reset();
  napi_release_threadsafe_function(raw->completion, napi_tsfn_release);
  return promise;
}

napi_value StartNativeCopy(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request, napi_value progress) {
  if (state->copy_busy) return Fail(env, "Busy", "Only one copy may run in a native session.");
  if (!PinModuleForAsyncWork()) return Fail(env, "NativeFailure", "Cannot retain the native module for copy work.");
  if (!Object(env, request)) return Fail(env, "InvalidRequest", "A native copy request is required.");
  auto job = std::make_unique<CopyJob>(); job->state = state;
  if (!Field(env, request, "source", 32767, &job->request.source) || !Field(env, request, "target", 32767, &job->request.target)) return Fail(env, "InvalidRequest", "Native copy paths must be strings.");
  napi_value roots, expected;
  bool array;
  uint32_t count;
  if (napi_get_named_property(env, request, "roots", &roots) != napi_ok || napi_is_array(env, roots, &array) != napi_ok || !array || napi_get_array_length(env, roots, &count) != napi_ok || !count || napi_get_named_property(env, request, "expected", &expected) != napi_ok || !Object(env, expected)) return Fail(env, "InvalidRequest", "Allowed roots and a complete identity are required.");
  for (uint32_t i = 0; i < count; ++i) {
    napi_value value; std::wstring root;
    CHECK(napi_get_element(env, roots, i, &value));
    if (!ReadString(env, value, 32767, &root)) return Fail(env, "InvalidRequest", "Native copy roots must be strings.");
    job->request.roots.push_back(std::move(root));
  }
  struct FieldSpec { const char* name; std::string* target; bool negative; };
  const FieldSpec fields[] = {{"dev", &job->request.expected_source.dev, false}, {"ino", &job->request.expected_source.ino, false}, {"size", &job->request.expected_source.size, false}, {"mtimeNs", &job->request.expected_source.mtime_ns, true}, {"ctimeNs", &job->request.expected_source.ctime_ns, true}};
  for (const auto& field : fields) {
    std::wstring value;
    if (!Field(env, expected, field.name, 24, &value) || value.empty()) return Fail(env, "InvalidRequest", "A complete decimal source identity is required.");
    for (size_t i = 0; i < value.size(); ++i) {
      if (!(value[i] >= L'0' && value[i] <= L'9') && !(i == 0 && field.negative && value.size() > 1 && value[i] == L'-')) return Fail(env, "InvalidRequest", "A complete decimal source identity is required.");
      field.target->push_back(static_cast<char>(value[i]));
    }
  }
  if (!state->copy_session) state->copy_session = CreateNativeFileTransferSession();
  job->session = state->copy_session;
  job->io_ticket = NextCopyTicket();
  napi_value promise, cancel;
  CHECK(napi_create_promise(env, &job->deferred, &promise));
  auto cancellation = std::make_unique<Cancellation>(Cancellation{job->cancelled, job->finished, job->session});
  CHECK(napi_create_function(env, "cancel", NAPI_AUTO_LENGTH, Cancel, cancellation.get(), &cancel));
  CHECK(napi_add_finalizer(env, cancel, cancellation.get(), DeleteCancel, nullptr, nullptr));
  cancellation.release();
  CHECK(napi_set_named_property(env, promise, "cancel", cancel));
  auto io_cancellation = std::make_unique<IoCancellation>(IoCancellation{job->finished, job->session, job->io_ticket});
  napi_value cancel_io;
  CHECK(napi_create_function(env, "cancelIo", NAPI_AUTO_LENGTH, CancelIo, io_cancellation.get(), &cancel_io));
  CHECK(napi_add_finalizer(env, cancel_io, io_cancellation.get(), DeleteCancelIo, nullptr, nullptr));
  io_cancellation.release();
  CHECK(napi_set_named_property(env, promise, "cancelIo", cancel_io));
  napi_valuetype type;
  CHECK(napi_typeof(env, progress, &type));
  if (type == napi_function) {
    auto progress_lifetime = std::make_unique<std::shared_ptr<ProgressChannel>>(job->progress_channel);
    if (napi_create_threadsafe_function(env, progress, nullptr, Text(env, "files.copy.progress"), 1, 1, progress_lifetime.get(), FinalizeProgress, job->progress_channel.get(), Progress, &job->progress) != napi_ok) return Fail(env, "BindingFailure", "Cannot create native copy progress.");
    progress_lifetime.release();
    if (napi_acquire_threadsafe_function(job->progress) != napi_ok) {
      ReleaseFunctionOnce(job->progress);
      job->progress = nullptr;
      return Fail(env, "BindingFailure", "Cannot retain native copy progress.");
    }
  }
  auto* raw = job.get();
  RetainCopyJob(raw);
  napi_value resource = Text(env, "files.copy.complete");
  if (!resource || napi_create_threadsafe_function(env, nullptr, nullptr, resource, 0, 1,
                                      raw, FinalizeCopy, raw, Complete, &raw->completion) != napi_ok) {
    ReleaseCopyJob(raw);
    ReleaseUnstartedFunction(raw->progress);
    raw->progress = nullptr;
    return Fail(env, "BindingFailure", "Cannot create native copy completion.");
  }
  job.release();
  ReleaseCopyJob(raw);
  if (napi_acquire_threadsafe_function(raw->completion) != napi_ok) {
    const auto progress_function = raw->progress;
    raw->progress = nullptr;
    ReleaseUnstartedFunction(progress_function);
    ReleaseFunctionOnce(raw->completion);
    return Fail(env, "BindingFailure", "Cannot retain native copy completion.");
  }
  if (!raw->session->RegisterQueuedCopy()) {
    const auto progress_function = raw->progress;
    raw->progress = nullptr;
    ReleaseUnstartedFunction(progress_function);
    ReleaseUnstartedFunction(raw->completion);
    return Fail(env, "SessionClosed", "The native copy session is closed.");
  }
  state->copy_busy = true;
  RetainCopyJob(raw);
  if (!TrySubmitThreadpoolCallback(Execute, raw, nullptr)) {
    ReleaseCopyJob(raw);
    auto* session = raw->session.get();
    session->CancelQueuedCopy();
    state->copy_busy = false;
    const auto progress_function = raw->progress;
    raw->progress = nullptr;
    ReleaseUnstartedFunction(progress_function);
    ReleaseUnstartedFunction(raw->completion);
    return Fail(env, "BindingFailure", "Cannot queue native copy work.");
  }
  if (raw->progress) napi_release_threadsafe_function(raw->progress, napi_tsfn_release);
  napi_release_threadsafe_function(raw->completion, napi_tsfn_release);
  return promise;
}

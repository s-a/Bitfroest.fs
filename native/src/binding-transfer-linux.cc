#include "binding-transfer-linux.h"
#include "file-transfer-win.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <utility>
#include <vector>

namespace {
struct ProgressChannel {
  std::mutex mutex;
  std::optional<FileTransferProgress> latest;
  bool queued = false;
  std::atomic<bool> closing{false};
};
struct CopyJob {
  std::shared_ptr<SessionState> state;
  std::shared_ptr<FileTransferSession> session;
  FileTransferRequest request;
  FileTransferResult result;
  std::shared_ptr<std::atomic<bool>> cancelled = std::make_shared<std::atomic<bool>>(false);
  std::shared_ptr<std::atomic<bool>> finished = std::make_shared<std::atomic<bool>>(false);
  std::shared_ptr<ProgressChannel> channel = std::make_shared<ProgressChannel>();
  napi_async_work work = nullptr;
  napi_threadsafe_function progress = nullptr;
  napi_deferred deferred = nullptr;
  uint64_t io_ticket = 0;
  bool entered = false;
};
struct ShutdownJob {
  std::shared_ptr<FileTransferSession> session;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  bool failed = false;
};
struct Cancellation { std::shared_ptr<std::atomic<bool>> requested, finished; std::shared_ptr<FileTransferSession> session; };
struct IoCancellation { std::shared_ptr<std::atomic<bool>> finished; std::shared_ptr<FileTransferSession> session; uint64_t ticket = 0; };

napi_value Fail(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message); return nullptr;
}
#define CHECK(call) do { if ((call) != napi_ok) return Fail(env, "BindingFailure", "The Linux copy binding failed."); } while (false)
napi_value Text(napi_env env, const std::string& value) {
  napi_value result;
  CHECK(napi_create_string_utf8(env, value.data(), value.size(), &result));
  return result;
}
bool Object(napi_env env, napi_value value) {
  napi_valuetype type; napi_value null_value; bool is_null = false;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_object &&
      napi_get_null(env, &null_value) == napi_ok && napi_strict_equals(env, value, null_value, &is_null) == napi_ok && !is_null;
}
bool ReadString(napi_env env, napi_value value, size_t limit, std::wstring* result) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || length > limit) return false;
  std::vector<char16_t> buffer(length + 1);
  if (napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
  result->clear();
  for (size_t index = 0; index < length; ++index) {
    uint32_t codepoint = buffer[index];
    if (codepoint >= 0xd800 && codepoint <= 0xdbff) {
      if (++index >= length || buffer[index] < 0xdc00 || buffer[index] > 0xdfff) return false;
      codepoint = 0x10000 + ((codepoint - 0xd800) << 10) + (buffer[index] - 0xdc00);
    } else if (codepoint >= 0xdc00 && codepoint <= 0xdfff) return false;
    if (!codepoint) return false;
    result->push_back(static_cast<wchar_t>(codepoint));
  }
  return true;
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
const char* Status(FileTransferStatus status) {
  switch (status) {
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
  if (job.result.expected_source && job.result.observed_source) {
    napi_value source;
    CHECK(napi_create_object(env, &source));
    CHECK(napi_set_named_property(env, source, "expected", Identity(env, *job.result.expected_source)));
    CHECK(napi_set_named_property(env, source, "observed", Identity(env, *job.result.observed_source)));
    CHECK(napi_set_named_property(env, result, "sourceIdentity", source));
  }
  return result;
}
void Progress(napi_env env, napi_value callback, void* context, void*) {
  auto* channel = static_cast<ProgressChannel*>(context);
  if (!env || !callback || !channel) return;
  std::optional<FileTransferProgress> event;
  {
    std::lock_guard<std::mutex> lock(channel->mutex);
    event = std::move(channel->latest); channel->latest.reset(); channel->queued = false;
  }
  if (!event) return;
  napi_value value, transferred, total, receiver, ignored;
  if (napi_create_object(env, &value) != napi_ok ||
      napi_create_double(env, static_cast<double>(event->transferred), &transferred) != napi_ok ||
      napi_create_double(env, static_cast<double>(event->total), &total) != napi_ok) return;
  napi_set_named_property(env, value, "transferred", transferred);
  napi_set_named_property(env, value, "total", total);
  if (event->owned_destination) napi_set_named_property(env, value, "ownedDestination", Identity(env, event->owned_destination->identity));
  napi_get_undefined(env, &receiver);
  if (napi_call_function(env, receiver, callback, 1, &value, &ignored) != napi_ok) {
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) napi_get_and_clear_last_exception(env, &ignored);
  }
}
void FinalizeProgress(napi_env, void* data, void*) { delete static_cast<std::shared_ptr<ProgressChannel>*>(data); }
void QueueProgress(CopyJob* job, const FileTransferProgress& event) {
  if (!job->progress || job->channel->closing.load() || event.transferred > 9007199254740991ULL || event.total > 9007199254740991ULL) return;
  bool schedule = false;
  {
    std::lock_guard<std::mutex> lock(job->channel->mutex);
    if (job->channel->closing.load()) return;
    job->channel->latest = event;
    if (!job->channel->queued) { job->channel->queued = true; schedule = true; }
  }
  if (!schedule) return;
  const napi_status status = napi_call_threadsafe_function(job->progress, nullptr, napi_tsfn_blocking);
  if (status == napi_closing || (status != napi_ok && status != napi_queue_full)) {
    std::lock_guard<std::mutex> lock(job->channel->mutex);
    job->channel->closing.store(true); job->channel->queued = false; job->channel->latest.reset();
  }
}
void ReleaseProgress(CopyJob* job, napi_threadsafe_function_release_mode mode = napi_tsfn_abort) {
  if (job->progress) { napi_release_threadsafe_function(job->progress, mode); job->progress = nullptr; }
}
void ExecuteCopy(napi_env, void* data) {
  auto* job = static_cast<CopyJob*>(data);
  try {
    job->entered = job->session->Copy(job->request,
      [job] { return job->cancelled->load() || job->state->closed.load(); },
      [job](const FileTransferProgress& value) { QueueProgress(job, value); }, &job->result, job->io_ticket);
  } catch (const std::bad_alloc&) { job->result.status = FileTransferStatus::kUnknown; job->result.code = "ResourceExhausted"; }
  catch (...) { job->result.status = FileTransferStatus::kUnknown; job->result.code = "NativeFailure"; }
  if (!job->entered) job->session->CancelQueuedCopy();
  job->finished->store(true);
  if (job->progress && !job->channel->closing.load()) napi_release_threadsafe_function(job->progress, napi_tsfn_release);
}
void CompleteCopy(napi_env env, napi_status status, void* data) {
  std::unique_ptr<CopyJob> job(static_cast<CopyJob*>(data));
  if (job->entered) job->session->FinishCopy();
  job->state->copy_busy = false;
  if (job->work && env) napi_delete_async_work(env, job->work);
  if (!env) return;
  if (status != napi_ok) { napi_value error; if (napi_create_error(env, Text(env, "NativeFailure"), Text(env, "The Linux copy worker failed."), &error) == napi_ok) napi_reject_deferred(env, job->deferred, error); return; }
  napi_value outcome = Outcome(env, *job);
  if (!outcome) return;
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
}
void FinalizeCancel(napi_env, void* data, void*) { delete static_cast<Cancellation*>(data); }
void FinalizeCancelIo(napi_env, void* data, void*) { delete static_cast<IoCancellation*>(data); }
napi_value Cancel(napi_env env, napi_callback_info info) {
  void* data = nullptr;
  if (napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &data) != napi_ok) return Fail(env, "BindingFailure", "Cannot cancel native copy.");
  auto* value = static_cast<Cancellation*>(data); value->requested->store(true);
  if (!value->finished->load()) value->session->RequestCancel();
  napi_value result; CHECK(napi_get_undefined(env, &result)); return result;
}
napi_value CancelIo(napi_env env, napi_callback_info info) {
  void* data = nullptr;
  if (napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &data) != napi_ok) return Fail(env, "BindingFailure", "Cannot cancel native copy I/O.");
  auto* value = static_cast<IoCancellation*>(data);
  if (!value->finished->load()) value->session->RequestIoCancel(value->ticket);
  napi_value result; CHECK(napi_get_undefined(env, &result)); return result;
}
void ExecuteShutdown(napi_env, void* data) {
  auto* job = static_cast<ShutdownJob*>(data);
  try { job->session->AwaitStopped(); } catch (...) { job->failed = true; }
}
void CompleteShutdown(napi_env env, napi_status status, void* data) {
  std::unique_ptr<ShutdownJob> job(static_cast<ShutdownJob*>(data));
  if (job->work && env) napi_delete_async_work(env, job->work);
  if (!env) return;
  if (status != napi_ok || job->failed) {
    napi_value error;
    if (napi_create_error(env, Text(env, "NativeFailure"), Text(env, "Linux copy shutdown failed."), &error) == napi_ok) napi_reject_deferred(env, job->deferred, error);
  } else { napi_value value; if (napi_get_undefined(env, &value) == napi_ok) napi_resolve_deferred(env, job->deferred, value); }
}
bool ReadIdentityField(napi_env env, napi_value expected, const char* name, std::string* target, bool negative) {
  std::wstring value;
  if (!Field(env, expected, name, 24, &value) || value.empty()) return false;
  for (size_t index = 0; index < value.size(); ++index) {
    if (value[index] >= L'0' && value[index] <= L'9') target->push_back(static_cast<char>(value[index]));
    else if (index == 0 && negative && value.size() > 1 && value[index] == L'-') target->push_back('-');
    else return false;
  }
  return true;
}
uint64_t NextCopyTicket() {
  static std::atomic<uint64_t> next{1};
  uint64_t ticket = next.fetch_add(1, std::memory_order_relaxed);
  if (!ticket) ticket = next.fetch_add(1, std::memory_order_relaxed);
  return ticket;
}
}

napi_value StartLinuxCopy(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request, napi_value progress) {
  if (state->copy_busy) return Fail(env, "Busy", "Only one copy may run in a native session.");
  if (!Object(env, request)) return Fail(env, "InvalidRequest", "A native copy request is required.");
  auto job = std::make_unique<CopyJob>(); job->state = state;
  if (!Field(env, request, "source", 32767, &job->request.source) || !Field(env, request, "target", 32767, &job->request.target)) return Fail(env, "InvalidRequest", "Native copy paths must be strings.");
  napi_value roots, expected; bool array = false; uint32_t count = 0;
  if (napi_get_named_property(env, request, "roots", &roots) != napi_ok || napi_is_array(env, roots, &array) != napi_ok || !array ||
      napi_get_array_length(env, roots, &count) != napi_ok || !count || napi_get_named_property(env, request, "expected", &expected) != napi_ok || !Object(env, expected))
    return Fail(env, "InvalidRequest", "Allowed roots and a complete source identity are required.");
  for (uint32_t index = 0; index < count; ++index) {
    napi_value item; std::wstring root;
    CHECK(napi_get_element(env, roots, index, &item));
    if (!ReadString(env, item, 32767, &root)) return Fail(env, "InvalidRequest", "Native copy roots must be strings.");
    job->request.roots.push_back(std::move(root));
  }
  if (!ReadIdentityField(env, expected, "dev", &job->request.expected_source.dev, false) ||
      !ReadIdentityField(env, expected, "ino", &job->request.expected_source.ino, false) ||
      !ReadIdentityField(env, expected, "size", &job->request.expected_source.size, false) ||
      !ReadIdentityField(env, expected, "mtimeNs", &job->request.expected_source.mtime_ns, true) ||
      !ReadIdentityField(env, expected, "ctimeNs", &job->request.expected_source.ctime_ns, true))
    return Fail(env, "InvalidRequest", "A complete decimal source identity is required.");
  if (!state->copy_session) state->copy_session = CreateNativeFileTransferSession();
  job->session = state->copy_session;
  job->io_ticket = NextCopyTicket();
  napi_value promise, cancel, cancel_io;
  CHECK(napi_create_promise(env, &job->deferred, &promise));
  auto cancellation = std::make_unique<Cancellation>(Cancellation{job->cancelled, job->finished, job->session});
  CHECK(napi_create_function(env, "cancel", NAPI_AUTO_LENGTH, Cancel, cancellation.get(), &cancel));
  CHECK(napi_add_finalizer(env, cancel, cancellation.get(), FinalizeCancel, nullptr, nullptr)); cancellation.release();
  CHECK(napi_set_named_property(env, promise, "cancel", cancel));
  auto io_cancellation = std::make_unique<IoCancellation>(IoCancellation{job->finished, job->session, job->io_ticket});
  CHECK(napi_create_function(env, "cancelIo", NAPI_AUTO_LENGTH, CancelIo, io_cancellation.get(), &cancel_io));
  CHECK(napi_add_finalizer(env, cancel_io, io_cancellation.get(), FinalizeCancelIo, nullptr, nullptr)); io_cancellation.release();
  CHECK(napi_set_named_property(env, promise, "cancelIo", cancel_io));
  napi_valuetype type;
  CHECK(napi_typeof(env, progress, &type));
  if (type == napi_function) {
    auto lifetime = std::make_unique<std::shared_ptr<ProgressChannel>>(job->channel);
    if (napi_create_threadsafe_function(env, progress, nullptr, Text(env, "files.copy.progress"), 1, 1,
        lifetime.get(), FinalizeProgress, job->channel.get(), Progress, &job->progress) != napi_ok) return Fail(env, "BindingFailure", "Cannot create Linux copy progress.");
    lifetime.release();
  }
  napi_value resource = Text(env, "files.copy.complete");
  if (napi_create_async_work(env, nullptr, resource, ExecuteCopy, CompleteCopy, job.get(), &job->work) != napi_ok) {
    ReleaseProgress(job.get());
    return Fail(env, "BindingFailure", "Cannot create Linux copy work.");
  }
  if (!job->session->RegisterQueuedCopy()) {
    napi_delete_async_work(env, job->work); job->work = nullptr; ReleaseProgress(job.get());
    return Fail(env, "SessionClosed", "The native copy session is closed.");
  }
  state->copy_busy = true;
  if (napi_queue_async_work(env, job->work) != napi_ok) {
    job->session->CancelQueuedCopy(); state->copy_busy = false;
    napi_delete_async_work(env, job->work); job->work = nullptr; ReleaseProgress(job.get());
    return Fail(env, "BindingFailure", "Cannot queue Linux copy work.");
  }
  job.release();
  return promise;
}

napi_value ShutdownLinuxCopies(napi_env env, const std::shared_ptr<SessionState>& state) {
  auto job = std::make_unique<ShutdownJob>();
  napi_value promise;
  CHECK(napi_create_promise(env, &job->deferred, &promise));
  job->session = state->copy_session;
  if (!job->session) { napi_value value; CHECK(napi_get_undefined(env, &value)); CHECK(napi_resolve_deferred(env, job->deferred, value)); return promise; }
  job->session->Shutdown();
  napi_value resource = Text(env, "files.copy.shutdown");
  if (napi_create_async_work(env, nullptr, resource, ExecuteShutdown, CompleteShutdown, job.get(), &job->work) != napi_ok)
    return Fail(env, "BindingFailure", "Cannot create Linux copy shutdown work.");
  if (napi_queue_async_work(env, job->work) != napi_ok) {
    napi_delete_async_work(env, job->work); job->work = nullptr;
    return Fail(env, "BindingFailure", "Cannot queue Linux copy shutdown.");
  }
  state->copy_session.reset();
  job.release();
  return promise;
}

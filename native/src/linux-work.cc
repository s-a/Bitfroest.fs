#include "linux-work.h"
#include <condition_variable>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

struct LinuxLocksSessionState {
  size_t pending = 0;
  std::vector<napi_deferred> waiters;
};

namespace {
struct Work {
  std::shared_ptr<SessionState> session;
  std::shared_ptr<LinuxLocksSessionState> lifecycle;
  void* data = nullptr;
  LinuxWorkExecute execute = nullptr;
  LinuxWorkComplete complete = nullptr;
  LinuxWorkDestroy destroy = nullptr;
  std::thread worker;
  std::mutex start_mutex;
  std::condition_variable start_changed;
  bool start_approved = false;
  bool start_cancelled = false;
  napi_threadsafe_function completion = nullptr;
  napi_deferred deferred = nullptr;
  napi_ref fallback_error = nullptr;
  napi_ref start_callback = nullptr;
  napi_async_cleanup_hook_handle cleanup_handle = nullptr;
  napi_status status = napi_ok;
  bool cleanup_requested = false;
  bool delivered = false;
  bool startup_failed = false;
  ~Work() { if (destroy) destroy(data); }
};

void ResolveWaiters(napi_env env, const std::shared_ptr<LinuxLocksSessionState>& lifecycle) {
  if (lifecycle->pending) return;
  for (auto waiter : lifecycle->waiters) {
    napi_value undefined = nullptr;
    if (napi_get_undefined(env, &undefined) == napi_ok) napi_resolve_deferred(env, waiter, undefined);
  }
  lifecycle->waiters.clear();
}

napi_value Fail(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message);
  return nullptr;
}

void Complete(napi_env env, Work* work, napi_status status) {
  if (work->delivered) return;
  work->delivered = true;
  LinuxWorkResult result;
  try { result = work->complete(env, status, work->data); }
  catch (...) { }
  if (!result.value) {
    result.rejected = true;
    napi_get_reference_value(env, work->fallback_error, &result.value);
  }
  if (result.value) {
    if (result.rejected) napi_reject_deferred(env, work->deferred, result.value);
    else napi_resolve_deferred(env, work->deferred, result.value);
  }
}

void Cancel(Work* work) {
  work->session->closed.store(true);
  {
    std::lock_guard<std::mutex> lock(work->start_mutex);
    work->start_cancelled = true;
  }
  work->start_changed.notify_all();
}

void Cleanup(napi_async_cleanup_hook_handle, void* data) {
  auto* work = static_cast<Work*>(data);
  work->cleanup_requested = true;
  Cancel(work);
  if (work->worker.joinable()) work->worker.join();
  if (work->cleanup_handle) {
    const auto handle = work->cleanup_handle;
    work->cleanup_handle = nullptr;
    napi_remove_async_cleanup_hook(handle);
  }
}

napi_value ConfirmStart(napi_env env, napi_callback_info) {
  napi_value result = nullptr;
  napi_get_undefined(env, &result);
  return result;
}

void Deliver(napi_env env, napi_value callback, void* context, void* completion) {
  auto* work = static_cast<Work*>(context);
  napi_value receiver = nullptr, result = nullptr;
  const bool runnable = env && callback && !work->cleanup_requested &&
      napi_get_undefined(env, &receiver) == napi_ok &&
      napi_call_function(env, receiver, callback, 0, nullptr, &result) == napi_ok;
  if (!completion) {
    {
      std::lock_guard<std::mutex> lock(work->start_mutex);
      if (runnable && !work->session->closed.load()) work->start_approved = true;
      else work->start_cancelled = true;
    }
    work->start_changed.notify_all();
  } else if (runnable) {
    if (work->worker.joinable()) work->worker.join();
    Complete(env, work, work->status);
  }
}

bool CanRun(napi_env env, Work* work) {
  napi_value callback = nullptr, receiver = nullptr, result = nullptr;
  return env && !work->cleanup_requested &&
      napi_get_reference_value(env, work->start_callback, &callback) == napi_ok &&
      napi_get_undefined(env, &receiver) == napi_ok &&
      napi_call_function(env, receiver, callback, 0, nullptr, &result) == napi_ok;
}

void ReleaseReferences(napi_env env, Work* work) {
  if (!env) return;
  if (work->fallback_error) { napi_delete_reference(env, work->fallback_error); work->fallback_error = nullptr; }
  if (work->start_callback) { napi_delete_reference(env, work->start_callback); work->start_callback = nullptr; }
}

void Finalize(napi_env env, void* data, void*) {
  std::unique_ptr<Work> work(static_cast<Work*>(data));
  if (!work->delivered && !work->startup_failed) Cancel(work.get());
  if (work->worker.joinable()) work->worker.join();
  const bool runnable = CanRun(env, work.get());
  if (!work->delivered && runnable && !work->startup_failed) Complete(env, work.get(), napi_cancelled);
  if (work->lifecycle->pending) --work->lifecycle->pending;
  if (runnable) ResolveWaiters(env, work->lifecycle);
  ReleaseReferences(env, work.get());
  if (work->cleanup_handle) napi_remove_async_cleanup_hook(work->cleanup_handle);
}

void Run(Work* work) {
  napi_status status = napi_call_threadsafe_function(work->completion, nullptr, napi_tsfn_nonblocking);
  if (status == napi_closing) return;
  if (status == napi_ok) {
    std::unique_lock<std::mutex> lock(work->start_mutex);
    work->start_changed.wait(lock, [&] { return work->start_approved || work->start_cancelled; });
    if (!work->start_approved || work->start_cancelled || work->session->closed.load()) work->status = napi_cancelled;
    lock.unlock();
    if (work->status == napi_ok) {
      try { work->execute(work->data); }
      catch (...) { work->status = napi_generic_failure; }
    }
    status = napi_call_threadsafe_function(work->completion, work, napi_tsfn_nonblocking);
  }
  if (status != napi_closing) napi_release_threadsafe_function(work->completion, napi_tsfn_release);
}
}

napi_value QueueLinuxWork(napi_env env, const std::shared_ptr<SessionState>& state,
                         const char* operation, void* data, LinuxWorkExecute execute,
                         LinuxWorkComplete complete, LinuxWorkDestroy destroy) {
  std::unique_ptr<void, LinuxWorkDestroy> payload(data, destroy);
  auto work = std::make_unique<Work>();
  work->execute = execute;
  work->complete = complete;
  work->destroy = destroy;
  work->data = payload.release();
  work->session = state;
  if (!state || state->closed.load()) return Fail(env, "SessionClosed", "The native session is closed.");
  if (!state->linux_locks_session) state->linux_locks_session = std::make_shared<LinuxLocksSessionState>();
  work->lifecycle = state->linux_locks_session;
  napi_value promise, resource, callback;
  if (napi_create_promise(env, &work->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, operation, NAPI_AUTO_LENGTH, &resource) != napi_ok ||
      napi_create_function(env, "confirmStart", NAPI_AUTO_LENGTH, ConfirmStart, nullptr, &callback) != napi_ok)
    return Fail(env, "BindingFailure", "The native request could not be created.");
  napi_value fallback_code, fallback_message, fallback_error;
  if (napi_create_string_utf8(env, "BindingFailure", NAPI_AUTO_LENGTH, &fallback_code) != napi_ok ||
      napi_create_string_utf8(env, "The native completion failed.", NAPI_AUTO_LENGTH, &fallback_message) != napi_ok ||
      napi_create_error(env, fallback_code, fallback_message, &fallback_error) != napi_ok ||
      napi_create_reference(env, fallback_error, 1, &work->fallback_error) != napi_ok ||
      napi_create_reference(env, callback, 1, &work->start_callback) != napi_ok) {
    ReleaseReferences(env, work.get());
    return Fail(env, "BindingFailure", "The native completion resources could not be created.");
  }
  ++work->lifecycle->pending;
  if (napi_create_threadsafe_function(env, callback, nullptr, resource, 0, 1,
          work.get(), Finalize, work.get(), Deliver, &work->completion) != napi_ok) {
    --work->lifecycle->pending;
    ReleaseReferences(env, work.get());
    return Fail(env, "BindingFailure", "The native completion channel could not be created.");
  }
  auto* queued = work.release();
  if (napi_add_async_cleanup_hook(env, Cleanup, queued, &queued->cleanup_handle) != napi_ok) {
    queued->startup_failed = true;
    napi_release_threadsafe_function(queued->completion, napi_tsfn_abort);
    return Fail(env, "BindingFailure", "The native cleanup hook could not be registered.");
  }
  try { queued->worker = std::thread(Run, queued); }
  catch (...) {
    queued->startup_failed = true;
    napi_release_threadsafe_function(queued->completion, napi_tsfn_abort);
    return Fail(env, "ResourceExhausted", "The native worker could not be started.");
  }
  return promise;
}

napi_value WhenLinuxWorkClosed(napi_env env, const std::shared_ptr<SessionState>& state) {
  napi_deferred deferred;
  napi_value promise;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) return nullptr;
  const auto lifecycle = state ? state->linux_locks_session : nullptr;
  if (!lifecycle || !lifecycle->pending) {
    napi_value undefined;
    if (napi_get_undefined(env, &undefined) == napi_ok) napi_resolve_deferred(env, deferred, undefined);
  } else {
    try { lifecycle->waiters.push_back(deferred); }
    catch (...) {
      napi_value message, error;
      if (napi_create_string_utf8(env, "The native close barrier could not be registered.", NAPI_AUTO_LENGTH, &message) == napi_ok &&
          napi_create_error(env, nullptr, message, &error) == napi_ok) napi_reject_deferred(env, deferred, error);
    }
  }
  return promise;
}

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include "windows-async-work.h"
#include <atomic>
#include <mutex>
#include <new>

namespace {
struct Work {
  std::atomic<unsigned int> references{1};
  void* data;
  WindowsWorkExecute execute;
  WindowsWorkComplete complete;
  WindowsWorkDestroy destroy;
  napi_threadsafe_function completion = nullptr;
  napi_status status = napi_ok;
};
void Release(Work* work) {
  if (work->references.fetch_sub(1) == 1) { work->destroy(work->data); delete work; }
}
void Finalize(napi_env, void* data, void*) { Release(static_cast<Work*>(data)); }
void Complete(napi_env env, napi_value, void* data, void*) {
  auto* work = static_cast<Work*>(data);
  if (env) work->complete(env, work->status, work->data);
}
void CALLBACK Execute(PTP_CALLBACK_INSTANCE, void* data) {
  auto* work = static_cast<Work*>(data);
  try { work->execute(nullptr, work->data); }
  catch (...) { work->status = napi_generic_failure; }
  const napi_status queued = napi_call_threadsafe_function(work->completion, nullptr, napi_tsfn_nonblocking);
  if (queued != napi_closing) napi_release_threadsafe_function(work->completion, napi_tsfn_release);
  Release(work);
}
bool PinModule() {
  static std::once_flag once;
  static bool pinned = false;
  std::call_once(once, [] {
    HMODULE module = nullptr;
    pinned = GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                               reinterpret_cast<LPCWSTR>(&Execute), &module) != FALSE;
  });
  return pinned;
}
}

napi_status QueueWindowsWork(napi_env env, const char* operation, void* data,
                             WindowsWorkExecute execute, WindowsWorkComplete complete,
                             WindowsWorkDestroy destroy) {
  auto* work = new (std::nothrow) Work{{1}, data, execute, complete, destroy};
  if (!work) { destroy(data); return napi_generic_failure; }
  napi_value resource;
  try {
    if (!PinModule() || napi_create_string_utf8(env, operation, NAPI_AUTO_LENGTH, &resource) != napi_ok) {
      Release(work); return napi_generic_failure;
    }
  } catch (...) { Release(work); return napi_generic_failure; }
  const napi_status created = napi_create_threadsafe_function(env, nullptr, nullptr, resource, 1, 2,
      work, Finalize, work, Complete, &work->completion);
  if (created != napi_ok) { Release(work); return created; }
  work->references.fetch_add(1);
  if (!TrySubmitThreadpoolCallback(Execute, work, nullptr)) {
    Release(work);
    const auto completion = work->completion;
    napi_release_threadsafe_function(completion, napi_tsfn_abort);
    napi_release_threadsafe_function(completion, napi_tsfn_release);
    return napi_generic_failure;
  }
  napi_release_threadsafe_function(work->completion, napi_tsfn_release);
  return napi_ok;
}

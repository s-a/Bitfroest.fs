#include "folder-icons-posix.h"
#include <algorithm>
#include <utility>

namespace {
struct Job {
  std::shared_ptr<SessionState> state;
  std::vector<PosixIconRequest> requests;
  std::vector<PosixIconResult> results;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  const char* error = nullptr;
};
struct Lifecycle {
  std::weak_ptr<SessionState> state;
  size_t pending = 0;
  std::vector<napi_deferred> waiters;
};
thread_local std::vector<Lifecycle> lifecycles;

napi_value Fail(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message); return nullptr;
}
napi_value Text(napi_env env, const std::string& value) {
  napi_value result = nullptr;
  napi_create_string_utf8(env, value.data(), value.size(), &result); return result;
}
bool Object(napi_env env, napi_value value) {
  napi_valuetype type;
  napi_value null;
  bool same = true, array = true;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_object &&
      napi_get_null(env, &null) == napi_ok && napi_strict_equals(env, value, null, &same) == napi_ok && !same &&
      napi_is_array(env, value, &array) == napi_ok && !array;
}
bool String(napi_env env, napi_value object, const char* name, size_t limit, std::string* result, bool optional = false) {
  bool has = false;
  napi_value value;
  napi_valuetype type;
  size_t length = 0, units = 0;
  if (napi_has_named_property(env, object, name, &has) != napi_ok) return false;
  if (!has) return optional;
  if (napi_get_named_property(env, object, name, &value) != napi_ok ||
      napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf16(env, value, nullptr, 0, &units) != napi_ok || units > limit ||
      napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char> bytes(length + 1);
  if (napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &length) != napi_ok) return false;
  result->assign(bytes.data(), length);
  return result->find('\0') == std::string::npos;
}
Lifecycle& Life(const std::shared_ptr<SessionState>& state) {
  lifecycles.erase(std::remove_if(lifecycles.begin(), lifecycles.end(), [](const auto& entry) {
    return entry.state.expired() && !entry.pending && entry.waiters.empty();
  }), lifecycles.end());
  for (auto& entry : lifecycles) if (entry.state.lock() == state) return entry;
  lifecycles.push_back({state, 0, {}}); return lifecycles.back();
}
void Execute(napi_env, void* data) {
  auto* job = static_cast<Job*>(data);
  try {
    if (!PosixIconsAvailable()) job->error = "Unavailable";
    else if (!job->state->closed) job->results = ResolvePosixIcons(job->requests, job->state->closed);
  } catch (const std::bad_alloc&) { job->error = "ResourceExhausted"; }
    catch (...) { job->error = "NativeFailure"; }
}
void Complete(napi_env env, napi_status status, void* data) {
  std::unique_ptr<Job> job(static_cast<Job*>(data));
  const char* error = job->state->closed ? "SessionClosed" : status != napi_ok ? "Cancelled" : job->error;
  napi_value value = nullptr;
  if (!error) {
    napi_value icons;
    if (napi_create_object(env, &value) != napi_ok || napi_create_array_with_length(env, job->results.size(), &icons) != napi_ok) error = "BindingFailure";
    if (!error) for (size_t i = 0; i < job->results.size(); ++i) {
      const auto& icon = job->results[i];
      napi_value row, png;
      if (icon.png.size() > 65536 || napi_create_object(env, &row) != napi_ok ||
          (icon.png.empty() ? napi_get_null(env, &png) : napi_create_buffer_copy(env, icon.png.size(), icon.png.data(), nullptr, &png)) != napi_ok ||
          napi_set_named_property(env, row, "key", Text(env, icon.key)) != napi_ok ||
          napi_set_named_property(env, row, "png", png) != napi_ok || napi_set_element(env, icons, static_cast<uint32_t>(i), row) != napi_ok) { error = "BindingFailure"; break; }
    }
    if (!error && napi_set_named_property(env, value, "icons", icons) != napi_ok) error = "BindingFailure";
  }
  if (error) {
    napi_create_error(env, Text(env, error), Text(env, "Native folder icon resolution failed."), &value);
    napi_set_named_property(env, value, "operation", Text(env, "icons.resolve"));
    napi_reject_deferred(env, job->deferred, value);
  } else napi_resolve_deferred(env, job->deferred, value);
  napi_delete_async_work(env, job->work);
  auto& life = Life(job->state);
  if (life.pending) --life.pending;
  if (!life.pending) {
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    for (auto waiter : life.waiters) napi_resolve_deferred(env, waiter, undefined);
    life.waiters.clear();
  }
}
}

napi_value StartPosixIcons(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request) {
  napi_value entries;
  bool array = false;
  uint32_t count = 0;
  if (!Object(env, request) || napi_get_named_property(env, request, "requests", &entries) != napi_ok ||
      napi_is_array(env, entries, &array) != napi_ok || !array ||
      napi_get_array_length(env, entries, &count) != napi_ok || count > 24) return Fail(env, "InvalidRequest", "At most 24 icon requests are allowed.");
  auto job = std::make_unique<Job>();
  job->state = state;
  for (uint32_t i = 0; i < count; ++i) {
    napi_value entry;
    PosixIconRequest icon;
    std::string type;
    if (napi_get_element(env, entries, i, &entry) != napi_ok || !Object(env, entry) ||
        !String(env, entry, "key", 300, &icon.key) || !String(env, entry, "path", 4096, &icon.path, true) ||
        !String(env, entry, "name", 300, &icon.name, true) || !String(env, entry, "iconResource", 4096, &icon.resource, true) ||
        !String(env, entry, "type", 10, &type) || (type != "folder" && type != "file") ||
        (!icon.path.empty() && icon.path.front() != '/')) return Fail(env, "InvalidRequest", "The native icon request is invalid.");
    icon.folder = type == "folder"; job->requests.push_back(std::move(icon));
  }
  napi_value promise;
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok ||
      napi_create_async_work(env, nullptr, Text(env, "icons.resolve"), Execute, Complete, job.get(), &job->work) != napi_ok) return Fail(env, "BindingFailure", "Cannot create native icon work.");
  if (napi_queue_async_work(env, job->work) != napi_ok) {
    napi_delete_async_work(env, job->work); return Fail(env, "BindingFailure", "Cannot queue native icon work.");
  }
  ++Life(state).pending;
  job.release(); return promise;
}

napi_value WhenPosixIconsClosed(napi_env env, const std::shared_ptr<SessionState>& state) {
  napi_deferred deferred;
  napi_value promise, undefined;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) return nullptr;
  auto& life = Life(state);
  if (life.pending) life.waiters.push_back(deferred);
  else { napi_get_undefined(env, &undefined); napi_resolve_deferred(env, deferred, undefined); }
  return promise;
}

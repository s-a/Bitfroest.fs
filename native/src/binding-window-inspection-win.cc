#include "window-inspection-win.h"
#include "windows-async-work.h"
#include <memory>

namespace {
struct Job {
  std::shared_ptr<SessionState> state;
  WindowInspection result;
  napi_deferred deferred = nullptr;
  bool success = false;
};
napi_value Text(napi_env env, const std::string& text) { napi_value value = nullptr; napi_create_string_utf8(env, text.data(), text.size(), &value); return value; }
bool Set(napi_env env, napi_value object, const char* key, napi_value value) { return value && napi_set_named_property(env, object, key, value) == napi_ok; }
bool Number(napi_env env, napi_value object, const char* key, double number) { napi_value value; return napi_create_double(env, number, &value) == napi_ok && Set(env, object, key, value); }
bool Boolean(napi_env env, napi_value object, const char* key, bool boolean) { napi_value value; return napi_get_boolean(env, boolean, &value) == napi_ok && Set(env, object, key, value); }
napi_value Rect(napi_env env, const RECT& rect) {
  napi_value value;
  if (napi_create_object(env, &value) != napi_ok || !Number(env, value, "x", rect.left) || !Number(env, value, "y", rect.top) ||
      !Number(env, value, "width", static_cast<double>(rect.right) - rect.left) || !Number(env, value, "height", static_cast<double>(rect.bottom) - rect.top)) return nullptr;
  return value;
}
void Execute(napi_env, void* data) {
  auto* job = static_cast<Job*>(data);
  try { job->success = InspectApplicationWindows(job->state->closed, &job->result); }
  catch (...) { job->result.error = ERROR_NOT_ENOUGH_MEMORY; }
}
napi_value Result(napi_env env, const WindowInspection& inspection) {
  napi_value result, rows;
  if (napi_create_object(env, &result) != napi_ok || napi_create_array_with_length(env, inspection.windows.size(), &rows) != napi_ok ||
      !Number(env, result, "version", 1) || !Boolean(env, result, "readOnly", true) || !Boolean(env, result, "truncated", inspection.truncated) ||
      !Number(env, result, "processId", inspection.process_id) || !Number(env, result, "matchingWindows", inspection.matching_windows) ||
      !Boolean(env, result, "compositionEnabled", inspection.composition_enabled) || !Number(env, result, "compositionResult", inspection.composition_result)) return nullptr;
  for (size_t i = 0; i < inspection.windows.size(); ++i) {
    const auto& window = inspection.windows[i]; napi_value row, class_name;
    if (napi_create_object(env, &row) != napi_ok ||
        napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(window.window_class.data()), window.window_class.size(), &class_name) != napi_ok ||
        !Set(env, row, "className", class_name) || !Set(env, row, "handle", Text(env, std::to_string(window.handle))) ||
        !Set(env, row, "owner", Text(env, std::to_string(window.owner))) || !Set(env, row, "processCreated", Text(env, std::to_string(window.process_created))) ||
        !Number(env, row, "processId", window.process_id) || !Number(env, row, "threadId", window.thread_id) ||
        !Number(env, row, "style", window.style) || !Number(env, row, "extendedStyle", window.extended_style) ||
        !Number(env, row, "showCommand", window.show_command) || !Number(env, row, "cloaked", window.cloaked) ||
        !Number(env, row, "cloakResult", window.cloak_result) || !Number(env, row, "frameResult", window.frame_result) ||
        !Number(env, row, "geometryError", window.geometry_error) || !Number(env, row, "dpi", window.dpi) ||
        !Number(env, row, "dpiAwareness", window.dpi_awareness) || !Boolean(env, row, "visible", window.visible) ||
        !Boolean(env, row, "minimized", window.minimized) || !Boolean(env, row, "maximized", window.maximized) ||
        !Boolean(env, row, "hung", window.hung) || !Boolean(env, row, "foreground", window.foreground) ||
        !Boolean(env, row, "identityStable", window.identity_stable) || !Boolean(env, row, "placementAvailable", window.placement_available) ||
        !Boolean(env, row, "centerHitSampled", window.center_hit_sampled) ||
        !Boolean(env, row, "centerWithinWindow", window.center_within_window) ||
        !Set(env, row, "rect", Rect(env, window.rect)) || !Set(env, row, "client", Rect(env, window.client)) ||
        !Set(env, row, "frame", Rect(env, window.frame)) || !Set(env, row, "normal", Rect(env, window.normal)) ||
        napi_set_element(env, rows, static_cast<uint32_t>(i), row) != napi_ok) return nullptr;
  }
  return Set(env, result, "windows", rows) ? result : nullptr;
}
void Complete(napi_env env, napi_status status, void* data) {
  auto* job = static_cast<Job*>(data);
  const char* code = job->state->closed ? "SessionClosed" : status != napi_ok ? "Cancelled" : !job->success ? "NativeFailure" : nullptr;
  napi_value result = code ? nullptr : Result(env, job->result);
  if (result) napi_resolve_deferred(env, job->deferred, result);
  else {
    napi_value error;
    if (napi_create_error(env, Text(env, code ? code : "BindingFailure"), Text(env, "Read-only window inspection failed."), &error) != napi_ok) return;
    Number(env, error, "nativeCode", job->result.error); Set(env, error, "operation", Text(env, "windows.inspect"));
    napi_reject_deferred(env, job->deferred, error);
  }
}
}

napi_value StartWindowInspection(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request) {
  napi_valuetype type; napi_value keys; uint32_t count = 1;
  bool array = false; napi_value null; bool is_null = true;
  if (napi_typeof(env, request, &type) != napi_ok || type != napi_object || napi_is_array(env, request, &array) != napi_ok || array || napi_get_null(env, &null) != napi_ok ||
      napi_strict_equals(env, request, null, &is_null) != napi_ok || is_null) {
    napi_throw_error(env, "InvalidRequest", "Window inspection requires an object."); return nullptr;
  }
  if (napi_get_property_names(env, request, &keys) != napi_ok || napi_get_array_length(env, keys, &count) != napi_ok || count != 0) {
    napi_throw_error(env, "InvalidRequest", "Window inspection requires an empty request."); return nullptr;
  }
  auto job = std::make_unique<Job>(); job->state = state;
  napi_value promise;
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok ||
      QueueWindowsWork(env, "windows.inspect", std::move(job), Execute, Complete) != napi_ok) {
    napi_throw_error(env, "BindingFailure", "Cannot queue window inspection."); return nullptr;
  }
  return promise;
}

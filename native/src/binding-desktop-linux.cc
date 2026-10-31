#include "binding-desktop-linux.h"
#include "desktop-linux.h"
#include "linux-work.h"
#include <gio/gio.h>
#include <cerrno>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace {
struct DesktopJob {
  std::shared_ptr<SessionState> state;
  std::string operation;
  std::string path;
  bool trash = false;
  bool inspect = false;
  LinuxDesktopResult result;
};

napi_value Text(napi_env env, const std::string& value) {
  napi_value result = nullptr;
  napi_create_string_utf8(env, value.data(), value.size(), &result);
  return result;
}

bool Boolean(napi_env env, napi_value object, const char* name, bool value) {
  napi_value result;
  return napi_get_boolean(env, value, &result) == napi_ok && napi_set_named_property(env, object, name, result) == napi_ok;
}

bool ReadRequest(napi_env env, napi_value request, DesktopJob* job) {
  napi_valuetype type;
  bool array;
  if (napi_typeof(env, request, &type) != napi_ok || type != napi_object ||
      napi_is_array(env, request, &array) != napi_ok || array) return false;
  napi_value inspect;
  if (napi_get_named_property(env, request, "inspectOnly", &inspect) != napi_ok || napi_typeof(env, inspect, &type) != napi_ok) return false;
  if (type != napi_undefined && (type != napi_boolean || napi_get_value_bool(env, inspect, &job->inspect) != napi_ok)) return false;
  if (job->trash) return true;
  napi_value path;
  size_t length = 0, written = 0;
  if (napi_get_named_property(env, request, "path", &path) != napi_ok || napi_typeof(env, path, &type) != napi_ok ||
      type != napi_string || napi_get_value_string_utf8(env, path, nullptr, 0, &length) != napi_ok || !length || length > 1048576) return false;
  std::vector<char> bytes(length + 1);
  if (napi_get_value_string_utf8(env, path, bytes.data(), bytes.size(), &written) != napi_ok || written != length) return false;
  job->path.assign(bytes.data(), written);
  return job->path.front() == '/' && job->path.find('\0') == std::string::npos;
}

void Execute(void* data) {
  auto* job = static_cast<DesktopJob*>(data);
  job->result = RunLinuxDesktop(job->path, job->trash, job->inspect, &job->state->closed);
}

LinuxWorkResult Complete(napi_env env, napi_status status, void* data) {
  auto* job = static_cast<DesktopJob*>(data);
  const auto& result = job->result;
  const bool closed = job->state->closed.load();
  const bool cancelled = result.cancelled || status == napi_cancelled;
  const bool gio_error = result.native_domain == "g-io-error-quark";
  const bool query_failure = job->inspect && !result.native_domain.empty() &&
      !(gio_error && result.native_error == G_IO_ERROR_NOT_SUPPORTED);
  if (closed || cancelled || status != napi_ok || query_failure || (!job->inspect && !result.requested)) {
    const char* code = closed ? "SessionClosed" : cancelled ? "Cancelled" : status != napi_ok ? "NativeFailure" :
        query_failure && gio_error && result.native_error == G_IO_ERROR_NOT_FOUND ? "NotFound" :
        query_failure && gio_error && result.native_error == G_IO_ERROR_PERMISSION_DENIED ? "Denied" :
        !result.available ? "Unavailable" : "NativeFailure";
    napi_value error, value, outcome;
    if (napi_create_error(env, Text(env, code), Text(env, result.error.empty() ? "The native desktop operation failed." : result.error), &error) != napi_ok ||
        napi_set_named_property(env, error, "operation", Text(env, job->operation)) != napi_ok ||
        napi_create_int32(env, result.native_error, &value) != napi_ok || napi_set_named_property(env, error, "nativeCode", value) != napi_ok ||
        napi_set_named_property(env, error, "nativeDomain", Text(env, result.native_domain)) != napi_ok ||
        napi_create_object(env, &outcome) != napi_ok ||
        napi_set_named_property(env, outcome, "status", Text(env, result.requested ? "committed" : result.submitted ? "unknown" : "unchanged")) != napi_ok ||
        !Boolean(env, outcome, "requested", result.requested) ||
        napi_set_named_property(env, error, "outcome", outcome) != napi_ok) return {};
    return {error, true};
  } else {
    napi_value response, outcome;
    if (napi_create_object(env, &response) != napi_ok || !Boolean(env, response, "available", result.available) ||
        !Boolean(env, response, "requested", result.requested) || !Boolean(env, response, "editor", result.editor) ||
        napi_create_object(env, &outcome) != napi_ok ||
        napi_set_named_property(env, outcome, "status", Text(env, result.requested ? "committed" : "unchanged")) != napi_ok ||
        !Boolean(env, outcome, "requested", result.requested) ||
        napi_set_named_property(env, response, "outcome", outcome) != napi_ok) return {};
    return {response, false};
  }
}
}

bool IsLinuxDesktopOperation(const char* operation) {
  return operation && (std::strcmp(operation, "shell.openAssociated") == 0 || std::strcmp(operation, "shell.openTrash") == 0);
}

napi_value StartLinuxDesktop(napi_env env, const std::shared_ptr<SessionState>& state,
                            const char* operation, napi_value request) {
  auto job = std::make_unique<DesktopJob>();
  job->state = state;
  job->operation = operation;
  job->trash = std::strcmp(operation, "shell.openTrash") == 0;
  if (!ReadRequest(env, request, job.get())) {
    napi_throw_error(env, "InvalidRequest", "The desktop request is invalid.");
    return nullptr;
  }
  return QueueLinuxWork(env, state, operation, job.release(), Execute, Complete,
      [](void* data) { delete static_cast<DesktopJob*>(data); });
}

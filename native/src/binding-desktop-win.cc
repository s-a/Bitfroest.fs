#include "binding-desktop-win.h"
#include "desktop-bridge-win.h"
#include "window-actions-win.h"
#include "windows-async-work.h"
#include <memory>
#include <vector>

namespace {
enum class Action { Association, Trash, Maximize, Terminal };
struct DesktopJob {
  Action action = Action::Association;
  const char* operation = "shell.openAssociated";
  std::shared_ptr<SessionState> state;
  std::wstring path;
  std::wstring parameters;
  bool inspect_only = false;
  DesktopAssociationResult result;
  DWORD native_error = ERROR_SUCCESS;
  const char* error = nullptr;
  napi_deferred deferred = nullptr;
};
napi_value Fail(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message);
  return nullptr;
}
bool Object(napi_env env, napi_value request) {
  napi_valuetype type;
  napi_value null_value;
  bool is_null = false, array = false;
  if (napi_typeof(env, request, &type) != napi_ok || type != napi_object ||
      napi_get_null(env, &null_value) != napi_ok ||
      napi_strict_equals(env, request, null_value, &is_null) != napi_ok || is_null ||
      napi_is_array(env, request, &array) != napi_ok || array) return false;
  return true;
}
bool Parse(napi_env env, napi_value request, DesktopJob* job) {
  if (!Object(env, request)) return false;
  napi_value value;
  size_t length = 0;
  if (napi_get_named_property(env, request, "path", &value) != napi_ok ||
      napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || !length || length > 32764) return false;
  std::vector<char16_t> buffer(length + 1);
  if (napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
  job->path.assign(buffer.begin(), buffer.begin() + length);
  if (job->path.find(L'\0') != std::wstring::npos) return false;
  const auto& path = job->path;
  const bool drive = path.size() >= 3 &&
      ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) &&
      path[1] == L':' && (path[2] == L'\\' || path[2] == L'/');
  const bool unc = path.size() >= 5 && path[0] == L'\\' && path[1] == L'\\';
  if (!drive && !unc) return false;
  bool has = false;
  if (napi_has_named_property(env, request, "inspectOnly", &has) != napi_ok) return false;
  if (has && (napi_get_named_property(env, request, "inspectOnly", &value) != napi_ok ||
              napi_get_value_bool(env, value, &job->inspect_only) != napi_ok)) return false;
  return true;
}
const char* ErrorCode(DWORD error) {
  switch (error) {
    case ERROR_FILE_NOT_FOUND: case ERROR_PATH_NOT_FOUND: return "NotFound";
    case ERROR_ACCESS_DENIED: case ERROR_PRIVILEGE_NOT_HELD: return "AccessDenied";
    case ERROR_CANCELLED: return "Cancelled";
    case ERROR_TIMEOUT: return "DesktopTimeout";
    case ERROR_NO_ASSOCIATION: return "NoAssociation";
    case ERROR_INVALID_DATA: return "InvalidResponse";
    default: return "NativeFailure";
  }
}
void ExecuteNative(DesktopJob* job) {
  try {
    if (job->state->closed) { job->error = "SessionClosed"; return; }
    const bool success = job->action == Action::Terminal
        ? OpenDesktopTerminal(job->path, job->inspect_only, &job->parameters, job->state->closed, &job->native_error)
        : job->action == Action::Trash
        ? ResolveTrashView(job->inspect_only, job->state->closed, &job->native_error)
        : job->action == Action::Maximize
        ? MaximizeOwnedWindow(job->path, job->state->closed, &job->native_error)
        : ResolveDesktopAssociation(job->path, job->inspect_only, &job->result, &job->native_error, &job->state->closed);
    if (!success) {
      job->error = ErrorCode(job->native_error);
    }
  } catch (const std::bad_alloc&) { job->error = "ResourceExhausted"; }
    catch (...) { job->error = "NativeFailure"; }
}
void Execute(napi_env, void* data) { ExecuteNative(static_cast<DesktopJob*>(data)); }
void Reject(napi_env env, DesktopJob* job, const char* code) {
  napi_value code_value, message, error, operation, number;
  if (napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) != napi_ok ||
      napi_create_string_utf8(env, "Native desktop association failed.", NAPI_AUTO_LENGTH, &message) != napi_ok ||
      napi_create_error(env, code_value, message, &error) != napi_ok) return;
  if (napi_create_string_utf8(env, job->operation, NAPI_AUTO_LENGTH, &operation) != napi_ok ||
      napi_create_uint32(env, job->native_error, &number) != napi_ok ||
      napi_set_named_property(env, error, "operation", operation) != napi_ok ||
      napi_set_named_property(env, error, "nativeCode", number) != napi_ok) return;
  napi_reject_deferred(env, job->deferred, error);
}
void Complete(napi_env env, napi_status status, void* data) {
  auto* job = static_cast<DesktopJob*>(data);
  const char* error = job->state->closed ? "SessionClosed" : status != napi_ok ? "NativeFailure" : job->error;
  if (error) { Reject(env, job, error); return; }
  napi_value result, editor;
  const bool value = job->action == Action::Association ? job->result.editor : job->action == Action::Trash || job->action == Action::Terminal ? !job->inspect_only : true;
  const char* field = job->action == Action::Association ? "editor" : job->action == Action::Trash || job->action == Action::Terminal ? "requested" : "maximized";
  if (napi_create_object(env, &result) != napi_ok || napi_get_boolean(env, value, &editor) != napi_ok ||
      napi_set_named_property(env, result, field, editor) != napi_ok) {
    Reject(env, job, "BindingFailure");
    return;
  }
  if (job->action == Action::Terminal) {
    napi_value parameters;
    if (napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(job->parameters.data()), job->parameters.size(), &parameters) != napi_ok ||
        napi_set_named_property(env, result, "parameters", parameters) != napi_ok) { Reject(env, job, "BindingFailure"); return; }
  }
  if (job->action == Action::Trash) {
    napi_value available;
    if (napi_get_boolean(env, true, &available) != napi_ok || napi_set_named_property(env, result, "available", available) != napi_ok) { Reject(env, job, "BindingFailure"); return; }
  }
  napi_resolve_deferred(env, job->deferred, result);
}
napi_value Queue(napi_env env, std::unique_ptr<DesktopJob> job) {
  napi_value promise, name;
  if (napi_create_string_utf8(env, job->operation, NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_promise(env, &job->deferred, &promise) != napi_ok) return Fail(env, "BindingFailure", "Cannot create native desktop request.");
  const char* operation = job->operation;
  if (QueueWindowsWork(env, operation, std::move(job), Execute, Complete) != napi_ok) {
    return Fail(env, "BindingFailure", "Cannot queue native desktop work.");
  }
  return promise;
}
}

napi_value StartNativeDesktopAssociation(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request) {
  try {
    auto job = std::make_unique<DesktopJob>();
    job->state = state;
    if (!Parse(env, request, job.get())) return Fail(env, "InvalidRequest", "An absolute file path and optional boolean inspectOnly are required.");
    return Queue(env, std::move(job));
  } catch (const std::bad_alloc&) { return Fail(env, "ResourceExhausted", "Cannot allocate native desktop association work."); }
    catch (...) { return Fail(env, "NativeFailure", "Cannot initialize native desktop association work."); }
}

napi_value StartNativeTerminal(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request) {
  auto job = std::make_unique<DesktopJob>(); job->state = state; job->action = Action::Terminal; job->operation = "shell.openTerminal";
  if (!Parse(env, request, job.get())) return Fail(env, "InvalidRequest", "An absolute directory path and optional boolean inspectOnly are required.");
  return Queue(env, std::move(job));
}

napi_value StartNativeTrash(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request) {
  auto job = std::make_unique<DesktopJob>(); job->state = state; job->action = Action::Trash; job->operation = "shell.openTrash";
  if (!Object(env, request)) return Fail(env, "InvalidRequest", "A trash-view request is required.");
  bool has = false; napi_value value;
  if (napi_has_named_property(env, request, "inspectOnly", &has) != napi_ok ||
      (has && (napi_get_named_property(env, request, "inspectOnly", &value) != napi_ok || napi_get_value_bool(env, value, &job->inspect_only) != napi_ok))) return Fail(env, "InvalidRequest", "inspectOnly must be a boolean.");
  return Queue(env, std::move(job));
}

napi_value StartNativeMaximize(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request) {
  auto job = std::make_unique<DesktopJob>(); job->state = state; job->action = Action::Maximize; job->operation = "windows.maximize";
  napi_value value; size_t length = 0;
  if (!Object(env, request) || napi_get_named_property(env, request, "titleToken", &value) != napi_ok ||
      napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || length < 16 || length > 128) return Fail(env, "InvalidRequest", "A unique title token between 16 and 128 characters is required.");
  std::vector<char16_t> token(length + 1);
  if (napi_get_value_string_utf16(env, value, token.data(), token.size(), &length) != napi_ok) return Fail(env, "InvalidRequest", "A title token is required.");
  job->path.assign(token.begin(), token.begin() + length);
  if (job->path.find(L'\0') != std::wstring::npos) return Fail(env, "InvalidRequest", "Title tokens cannot contain null characters.");
  return Queue(env, std::move(job));
}

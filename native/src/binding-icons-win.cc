#include "binding-icons-win.h"
#include "icons-bridge-win.h"
#include "windows-async-work.h"
#include <memory>

namespace {
struct IconJob {
  std::shared_ptr<SessionState> state;
  std::vector<FilesystemIconRequest> requests;
  std::vector<FilesystemIconResult> results;
  napi_deferred deferred = nullptr;
  DWORD native_error = 0;
  const char* error = nullptr;
};
napi_value Fail(napi_env env, const char* code, const char* message) { napi_throw_error(env, code, message); return nullptr; }
#define CHECK(call) do { if ((call) != napi_ok) return Fail(env, "BindingFailure", "Native icon binding failed."); } while (false)
napi_value Text(napi_env env, const char* value) {
  napi_value result;
  CHECK(napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result));
  return result;
}
bool Object(napi_env env, napi_value value) {
  napi_valuetype type;
  napi_value null_value;
  bool is_null;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_object && napi_get_null(env, &null_value) == napi_ok && napi_strict_equals(env, value, null_value, &is_null) == napi_ok && !is_null;
}
bool String(napi_env env, napi_value object, const char* name, size_t limit, std::wstring* result, bool optional = false) {
  napi_value value;
  bool has;
  if (napi_has_named_property(env, object, name, &has) != napi_ok) return false;
  if (!has) return optional;
  size_t length;
  if (napi_get_named_property(env, object, name, &value) != napi_ok || napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || length > limit) return false;
  std::vector<char16_t> bytes(length + 1);
  if (napi_get_value_string_utf16(env, value, bytes.data(), bytes.size(), &length) != napi_ok) return false;
  result->assign(bytes.begin(), bytes.begin() + length);
  return result->find(L'\0') == std::wstring::npos;
}
bool Key(napi_env env, napi_value object, std::string* result) {
  std::wstring wide;
  if (!String(env, object, "key", 300, &wide)) return false;
  napi_value value;
  size_t size;
  if (napi_get_named_property(env, object, "key", &value) != napi_ok || napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok) return false;
  std::vector<char> bytes(size + 1);
  if (napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &size) != napi_ok) return false;
  result->assign(bytes.data(), size);
  return true;
}
void Execute(napi_env, void* data) {
  auto* job = static_cast<IconJob*>(data);
  try {
    if (job->state->closed) { job->error = "SessionClosed"; return; }
    if (!ResolveFilesystemIcons(job->requests, &job->results, &job->native_error)) job->error = "NativeFailure";
  } catch (const std::bad_alloc&) { job->error = "ResourceExhausted"; }
    catch (...) { job->error = "NativeFailure"; }
}
napi_value Result(napi_env env, const IconJob& job) {
  napi_value result, icons;
  CHECK(napi_create_object(env, &result));
  CHECK(napi_create_array_with_length(env, job.results.size(), &icons));
  for (size_t i = 0; i < job.results.size(); ++i) {
    const auto& icon = job.results[i];
    if (icon.png.size() > 65536) return Fail(env, "InvalidResponse", "The native icon exceeds its size limit.");
    napi_value row, key, png;
    CHECK(napi_create_object(env, &row));
    CHECK(napi_create_string_utf8(env, icon.key.data(), icon.key.size(), &key));
    if (icon.png.empty()) CHECK(napi_get_null(env, &png));
    else CHECK(napi_create_buffer_copy(env, icon.png.size(), icon.png.data(), nullptr, &png));
    CHECK(napi_set_named_property(env, row, "key", key));
    CHECK(napi_set_named_property(env, row, "png", png));
    CHECK(napi_set_element(env, icons, static_cast<uint32_t>(i), row));
  }
  CHECK(napi_set_named_property(env, result, "icons", icons));
  return result;
}
void Complete(napi_env env, napi_status status, void* data) {
  auto* job = static_cast<IconJob*>(data);
  const char* code = job->state->closed ? "SessionClosed" : status != napi_ok ? "Cancelled" : job->error;
  if (code) {
    napi_value error, number;
    if (napi_create_error(env, Text(env, code), Text(env, "Native icon resolution failed."), &error) != napi_ok) return;
    napi_create_uint32(env, job->native_error, &number);
    napi_set_named_property(env, error, "nativeCode", number);
    napi_set_named_property(env, error, "operation", Text(env, "icons.resolve"));
    napi_reject_deferred(env, job->deferred, error);
  } else {
    napi_value result = Result(env, *job);
    if (result) napi_resolve_deferred(env, job->deferred, result);
  }
}
}

napi_value StartNativeIcons(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request) {
  napi_value requests;
  bool array;
  uint32_t count;
  if (!Object(env, request) || napi_get_named_property(env, request, "requests", &requests) != napi_ok || napi_is_array(env, requests, &array) != napi_ok || !array || napi_get_array_length(env, requests, &count) != napi_ok || count > 24) return Fail(env, "InvalidRequest", "An icon request array with at most 24 entries is required.");
  auto job = std::make_unique<IconJob>();
  job->state = state;
  for (uint32_t i = 0; i < count; ++i) {
    napi_value entry;
    CHECK(napi_get_element(env, requests, i, &entry));
    FilesystemIconRequest icon;
    std::wstring type;
    if (!Object(env, entry) || !Key(env, entry, &icon.key) || !String(env, entry, "path", 4096, &icon.path, true) || !String(env, entry, "name", 300, &icon.name, true) || !String(env, entry, "iconResource", 4096, &icon.icon_resource, true) || !String(env, entry, "type", 10, &type) || (type != L"file" && type != L"folder")) return Fail(env, "InvalidRequest", "The native icon request is invalid.");
    icon.folder = type == L"folder";
    job->requests.push_back(std::move(icon));
  }
  napi_value promise;
  CHECK(napi_create_promise(env, &job->deferred, &promise));
  if (!count) {
    napi_value result = Result(env, *job);
    if (result) CHECK(napi_resolve_deferred(env, job->deferred, result));
    return result ? promise : nullptr;
  }
  if (QueueWindowsWork(env, "icons.resolve", std::move(job), Execute, Complete) != napi_ok) return Fail(env, "BindingFailure", "Cannot queue native icon resolution.");
  return promise;
}

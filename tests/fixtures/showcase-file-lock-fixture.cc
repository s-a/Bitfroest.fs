#define WIN32_LEAN_AND_MEAN
#define NAPI_VERSION 8
#include <windows.h>
#include <node_api.h>
#include <string>
#include <vector>

namespace {
struct FileLock { HANDLE handle = INVALID_HANDLE_VALUE; };
void Finalize(napi_env, void* value, void*) {
  auto* lock = static_cast<FileLock*>(value);
  if (lock->handle != INVALID_HANDLE_VALUE) CloseHandle(lock->handle);
  delete lock;
}
napi_value Open(napi_env env, napi_callback_info info) {
  size_t count = 1, length = 0; napi_value arg;
  if (napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr) != napi_ok || count != 1 ||
      napi_get_value_string_utf16(env, arg, nullptr, 0, &length) != napi_ok || !length || length > 32767) {
    napi_throw_error(env, "InvalidPath", "A file path is required."); return nullptr;
  }
  std::vector<char16_t> buffer(length + 1);
  if (napi_get_value_string_utf16(env, arg, buffer.data(), buffer.size(), &length) != napi_ok) {
    napi_throw_error(env, "InvalidPath", "The file path cannot be read."); return nullptr;
  }
  const std::wstring name(buffer.begin(), buffer.begin() + length);
  if (name.find(L'\0') != std::wstring::npos) { napi_throw_error(env, "InvalidPath", "The file path contains a null character."); return nullptr; }
  HANDLE handle = CreateFileW(name.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (handle == INVALID_HANDLE_VALUE) { napi_throw_error(env, "OpenFailed", "The demo file could not be opened."); return nullptr; }
  auto* lock = new FileLock{handle}; napi_value result;
  if (napi_create_external(env, lock, Finalize, nullptr, &result) != napi_ok) {
    CloseHandle(handle); delete lock; napi_throw_error(env, "CreateFailed", "The demo lock could not be created."); return nullptr;
  }
  return result;
}
napi_value Close(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value arg; void* value = nullptr;
  if (napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr) != napi_ok || count != 1 ||
      napi_get_value_external(env, arg, &value) != napi_ok || !value) {
    napi_throw_error(env, "InvalidLock", "A demo lock is required."); return nullptr;
  }
  auto* lock = static_cast<FileLock*>(value);
  if (lock->handle != INVALID_HANDLE_VALUE) { CloseHandle(lock->handle); lock->handle = INVALID_HANDLE_VALUE; }
  napi_value result; napi_get_undefined(env, &result); return result;
}
napi_value Initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"open", nullptr, Open, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  if (napi_define_properties(env, exports, 2, methods) != napi_ok) return nullptr;
  return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)

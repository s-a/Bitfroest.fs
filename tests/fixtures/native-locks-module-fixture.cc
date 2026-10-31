#define WIN32_LEAN_AND_MEAN
#define NAPI_VERSION 8
#include <windows.h>
#include <node_api.h>
#include <string>
#include <vector>

namespace {
bool ReadPath(napi_env env, napi_callback_info info, std::wstring* path) {
  size_t count = 1, length = 0;
  napi_value value;
  if (napi_get_cb_info(env, info, &count, &value, nullptr, nullptr) != napi_ok || count != 1 ||
      napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || !length || length > 32767) return false;
  std::vector<char16_t> buffer(length + 1);
  if (napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
  path->assign(buffer.begin(), buffer.begin() + length);
  return path->find(L'\0') == std::wstring::npos;
}
napi_value Load(napi_env env, napi_callback_info info) {
  std::wstring path;
  if (!ReadPath(env, info, &path)) { napi_throw_error(env, "InvalidRequest", "A library path is required."); return nullptr; }
  HMODULE module = LoadLibraryW(path.c_str());
  if (!module) { napi_throw_error(env, "LoadFailed", "The fixture library could not be loaded."); return nullptr; }
  napi_value result;
  if (napi_create_bigint_uint64(env, reinterpret_cast<uintptr_t>(module), &result) != napi_ok) return nullptr;
  return result;
}
napi_value Loaded(napi_env env, napi_callback_info info) {
  std::wstring path;
  if (!ReadPath(env, info, &path)) { napi_throw_error(env, "InvalidRequest", "A library path is required."); return nullptr; }
  napi_value result;
  if (napi_get_boolean(env, GetModuleHandleW(path.c_str()) != nullptr, &result) != napi_ok) return nullptr;
  return result;
}
napi_value Initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"load", nullptr, Load, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"loaded", nullptr, Loaded, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  if (napi_define_properties(env, exports, 2, properties) != napi_ok) return nullptr;
  return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)

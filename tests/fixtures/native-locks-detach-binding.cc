#include "../../native/src/locks-win.h"

namespace {
napi_value Release(napi_env env, napi_callback_info info) {
  size_t count = 3;
  napi_value args[3], request, rows;
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 3 ||
      napi_create_object(env, &request) != napi_ok || napi_create_array_with_length(env, 1, &rows) != napi_ok ||
      napi_set_element(env, rows, 0, args[2]) != napi_ok ||
      napi_set_named_property(env, request, "path", args[0]) != napi_ok ||
      napi_set_named_property(env, request, "hostPid", args[1]) != napi_ok ||
      napi_set_named_property(env, request, "rows", rows) != napi_ok) return nullptr;
  return StartNativeLocks(env, std::make_shared<SessionState>(), "locks.releaseHandles", request);
}

napi_value ForceStopFailure(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value argument, result;
  bool enabled = false;
  if (napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr) != napi_ok || count != 1 ||
      napi_get_value_bool(env, argument, &enabled) != napi_ok) return nullptr;
  ForceDebugActiveProcessStopFailure(enabled);
  if (napi_get_undefined(env, &result) != napi_ok) return nullptr;
  return result;
}

napi_value TraceState(napi_env env, napi_callback_info) {
  const auto state = GetNativeLocksTraceState();
  napi_value result, api, active, process_id, handle;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_uint32(env, static_cast<uint32_t>(state.api), &api) != napi_ok ||
      napi_get_boolean(env, state.active, &active) != napi_ok ||
      napi_create_uint32(env, state.process_id, &process_id) != napi_ok ||
      napi_create_bigint_uint64(env, static_cast<uint64_t>(state.handle), &handle) != napi_ok ||
      napi_set_named_property(env, result, "api", api) != napi_ok ||
      napi_set_named_property(env, result, "active", active) != napi_ok ||
      napi_set_named_property(env, result, "processId", process_id) != napi_ok ||
      napi_set_named_property(env, result, "handle", handle) != napi_ok) return nullptr;
  return result;
}

napi_value Initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"release", nullptr, Release, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"forceStopFailure", nullptr, ForceStopFailure, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"traceState", nullptr, TraceState, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  if (napi_define_properties(env, exports, 3, properties) != napi_ok) return nullptr;
  return exports;
}
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)

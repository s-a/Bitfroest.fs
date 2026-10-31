#pragma once
#include <node_api.h>
#include <memory>

using WindowsWorkExecute = void (*)(napi_env, void*);
using WindowsWorkComplete = void (*)(napi_env, napi_status, void*);
using WindowsWorkDestroy = void (*)(void*);

napi_status QueueWindowsWork(napi_env env, const char* operation, void* data,
                             WindowsWorkExecute execute, WindowsWorkComplete complete,
                             WindowsWorkDestroy destroy);

template <typename T>
napi_status QueueWindowsWork(napi_env env, const char* operation, std::unique_ptr<T> data,
                             WindowsWorkExecute execute, WindowsWorkComplete complete) {
  return QueueWindowsWork(env, operation, data.release(), execute, complete,
                          [](void* value) { delete static_cast<T*>(value); });
}

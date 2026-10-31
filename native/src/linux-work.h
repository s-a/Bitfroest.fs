#pragma once
#include <node_api.h>
#include <memory>
#include "session.h"

using LinuxWorkExecute = void (*)(void*);
struct LinuxWorkResult {
  napi_value value = nullptr;
  bool rejected = true;
};
using LinuxWorkComplete = LinuxWorkResult (*)(napi_env, napi_status, void*);
using LinuxWorkDestroy = void (*)(void*);

napi_value QueueLinuxWork(napi_env env, const std::shared_ptr<SessionState>& state,
                         const char* operation, void* data, LinuxWorkExecute execute,
                         LinuxWorkComplete complete, LinuxWorkDestroy destroy);
napi_value WhenLinuxWorkClosed(napi_env env, const std::shared_ptr<SessionState>& state);

#pragma once

#include <node_api.h>
#include <memory>
#include "session.h"

bool IsLinuxLocksOperation(const char* operation);
napi_value StartLinuxLocks(napi_env env, const std::shared_ptr<SessionState>& state,
                           const char* operation, napi_value request);
napi_value WhenLinuxLocksClosed(napi_env env, const std::shared_ptr<SessionState>& state);

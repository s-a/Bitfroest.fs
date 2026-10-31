#pragma once
#include <node_api.h>
#include "session.h"

napi_value StartNativeCopy(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request, napi_value progress);
napi_value ShutdownNativeCopies(napi_env env, const std::shared_ptr<SessionState>& state);

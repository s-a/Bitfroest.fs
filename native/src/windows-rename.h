#pragma once
#include <node_api.h>
#include "session.h"

napi_value StartCaseRename(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request);

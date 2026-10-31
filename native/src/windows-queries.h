#pragma once
#include <node_api.h>
#include "session.h"

bool IsWindowsQuery(const char* operation);
napi_value StartWindowsQuery(napi_env env, const std::shared_ptr<SessionState>& state,
                            const char* operation, napi_value request);

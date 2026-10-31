#pragma once
#include <node_api.h>
#include <memory>
#include "session.h"

bool IsLinuxDesktopOperation(const char* operation);
napi_value StartLinuxDesktop(napi_env env, const std::shared_ptr<SessionState>& state,
                            const char* operation, napi_value request);

#pragma once
#include <node_api.h>
#include "session.h"

napi_value StartNativeDesktopAssociation(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request);
napi_value StartNativeTrash(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request);
napi_value StartNativeTerminal(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request);
napi_value StartNativeMaximize(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request);

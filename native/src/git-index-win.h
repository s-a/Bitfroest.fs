#pragma once
#include <node_api.h>
#include <memory>
struct SessionState;
napi_value StartGitUntrack(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request);
napi_value CloseGitIndexSession(napi_env env, const std::shared_ptr<SessionState>& state);

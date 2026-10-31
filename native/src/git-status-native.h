#pragma once
#include <node_api.h>
#include <memory>
#include "session.h"

napi_value StartGitStatus(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request, napi_value progress);
napi_value StartGitInfo(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request);
bool IsGitStatusOperation(const char* operation);
void InitializeGitStatus(napi_env env);

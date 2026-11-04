#pragma once
#include <node_api.h>
#include <memory>
#include <string>
#include "session.h"

bool IsLinuxClipboardOperation(const char* operation);
bool ProbeLinuxClipboard(std::string* reason);
napi_value StartLinuxClipboardQuery(napi_env env, const std::shared_ptr<SessionState>& state,
                                    const char* operation, napi_value request);
void CloseLinuxClipboardSession(const std::shared_ptr<SessionState>& state);
napi_value WhenLinuxClipboardClosed(napi_env env, const std::shared_ptr<SessionState>& state);

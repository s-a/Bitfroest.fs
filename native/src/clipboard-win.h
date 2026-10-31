#pragma once
#include <node_api.h>
#include <cstdint>
#include <memory>
#include "session.h"

bool IsWindowsClipboardOperation(const char* operation);
napi_value StartWindowsClipboardQuery(napi_env env, const std::shared_ptr<SessionState>& state,
                                      const char* operation, napi_value request);
void CloseWindowsClipboardSession(const std::shared_ptr<SessionState>& state);
napi_value CloseWindowsClipboardSessionAsync(napi_env env, const std::shared_ptr<SessionState>& state);
#ifdef CLIPBOARD_TESTING
bool VerifyWindowsClipboardStaLifecycleForTest();
napi_value StartWindowsClipboardBlockedOwnerTest(napi_env env);
void PrepareWindowsClipboardTestOwners(uint32_t count);
bool WaitWindowsClipboardTestOwners(uint32_t milliseconds);
napi_value CloseWindowsClipboardTestOwner(napi_env env, uint32_t index);
void ReleaseWindowsClipboardTestOwner();
#endif

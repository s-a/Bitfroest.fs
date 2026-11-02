#pragma once
#include <node_api.h>
#include <atomic>
#include <memory>
#include <string>
#include <vector>
#include "session.h"

struct PosixIconRequest {
  std::string key, path, name, resource;
  bool folder = false;
};
struct PosixIconResult {
  std::string key;
  std::vector<unsigned char> png;
};
bool PosixIconsAvailable();
std::vector<PosixIconResult> ResolvePosixIcons(const std::vector<PosixIconRequest>& requests,
                                            const std::atomic<bool>& closed);
napi_value StartPosixIcons(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request);
napi_value WhenPosixIconsClosed(napi_env env, const std::shared_ptr<SessionState>& state);

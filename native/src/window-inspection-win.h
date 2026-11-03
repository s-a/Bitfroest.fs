#pragma once
#include <windows.h>
#include <atomic>
#include <cstdint>
#include <string>
#include <vector>
#include <node_api.h>
#include "session.h"

struct InspectedWindow {
  uintptr_t handle = 0, owner = 0;
  DWORD process_id = 0, thread_id = 0;
  uint64_t process_created = 0;
  std::wstring window_class;
  RECT rect{}, client{}, frame{}, normal{};
  DWORD style = 0, extended_style = 0, show_command = 0, cloaked = 0, geometry_error = 0;
  HRESULT cloak_result = E_FAIL, frame_result = E_FAIL;
  UINT dpi = 0;
  int dpi_awareness = -1;
  bool visible = false, minimized = false, maximized = false, hung = false, foreground = false;
  bool identity_stable = false, placement_available = false, center_within_window = false, center_hit_sampled = false;
};
struct WindowInspection {
  std::vector<InspectedWindow> windows;
  std::wstring title_token;
  DWORD process_id = 0, matching_windows = 0, error = 0;
  bool truncated = false, composition_enabled = false;
  HRESULT composition_result = E_FAIL;
};
bool InspectApplicationWindows(const std::atomic<bool>& closed, WindowInspection* result, const std::wstring& title_token = {});
napi_value StartWindowInspection(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request);

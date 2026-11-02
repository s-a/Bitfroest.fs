#pragma once
#include <windows.h>
#include <atomic>
#include <string>

struct WindowActionDetails {
  const char* stage = "validate-token";
  unsigned int attempts = 0;
  unsigned int matches = 0;
  HWND window = nullptr;
  DWORD process_id = 0;
  bool visible = false;
  bool maximized = false;
  bool identity_stable = false;
  bool title_matches = false;
  bool action_started = false;
};

bool MaximizeOwnedWindow(const std::wstring& token, const std::atomic<bool>& closed, DWORD* error, WindowActionDetails* details);

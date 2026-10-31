#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shobjidl.h>
#include <atomic>
#include <string>
#include <vector>
#include <memory>
#include <node_api.h>

struct SessionState;

struct ShellContextMenuRequest {
  std::wstring mode;
  std::vector<std::wstring> paths;
  std::vector<std::wstring> roots;
  bool keyboard = false;
  std::wstring owner_title;
  std::wstring lock_inspection_label;
};

struct ShellContextMenuEntry {
  std::wstring label;
  std::wstring verb;
  bool submenu = false;
};

struct ShellContextMenuResult {
  bool displayed = false;
  bool invoked = false;
  bool cancelled = false;
  bool context_menu2 = false;
  bool context_menu3 = false;
  bool inspect_locks = false;
  DWORD native_milliseconds = 0;
  std::vector<ShellContextMenuEntry> entries;
};

bool ResolveShellContextMenu(const ShellContextMenuRequest& request,
                             const std::atomic<bool>& session_closed,
                             ShellContextMenuResult* result,
                             DWORD* native_error);

bool EnumerateShellMenu(HMENU menu, IContextMenu* context,
                       std::vector<ShellContextMenuEntry>* entries,
                       DWORD* native_error);

bool RelayShellMenuMessage(IContextMenu2* second, IContextMenu3* third,
                           UINT message, WPARAM wparam, LPARAM lparam,
                           LRESULT* result);

napi_value StartNativeShellContextMenu(napi_env env,
                                       const std::shared_ptr<SessionState>& state,
                                       napi_value request);

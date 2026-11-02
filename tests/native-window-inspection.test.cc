#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include "window-inspection-win.h"

int main() {
  const wchar_t* name = L"WindowInspectionFixture";
  WNDCLASSW cls{}; cls.lpfnWndProc = DefWindowProcW; cls.hInstance = GetModuleHandleW(nullptr); cls.lpszClassName = name;
  if (!RegisterClassW(&cls)) return 1;
  HWND window = CreateWindowExW(0, name, L"fixture", WS_OVERLAPPEDWINDOW, 80, 90, 320, 180, nullptr, nullptr, cls.hInstance, nullptr);
  if (!window) return 2;
  RECT before{}; GetWindowRect(window, &before);
  WindowInspection result; std::atomic<bool> closed{false};
  const bool inspected = InspectApplicationWindows(closed, &result);
  bool found = false;
  for (const auto& item : result.windows) if (item.handle == reinterpret_cast<uintptr_t>(window)) {
    found = item.window_class == name && !item.visible && item.identity_stable && item.process_id == GetCurrentProcessId() &&
        item.rect.left == before.left && item.rect.right == before.right && item.process_created != 0;
  }
  RECT after{}; GetWindowRect(window, &after);
  const bool unchanged = EqualRect(&before, &after) && !IsWindowVisible(window);
  DestroyWindow(window); UnregisterClassW(name, cls.hInstance);
  if (!inspected || !found || !unchanged) return 3;
  closed = true;
  if (InspectApplicationWindows(closed, &result) || result.error != ERROR_CANCELLED) return 4;
  std::puts("Read-only hidden-window inspection passed.");
  return 0;
}

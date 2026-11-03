#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "window-inspection-win.h"
#include <dwmapi.h>
#include <array>
#include <map>

namespace {
constexpr size_t kMaxWindows = 64;
struct ProcessIdentity { bool matches = false; uint64_t created = 0; };
struct InspectionContext {
  const std::wstring* executable;
  const std::atomic<bool>* closed;
  WindowInspection* result;
  std::map<DWORD, ProcessIdentity> processes;
};
ProcessIdentity Identify(DWORD pid, const std::wstring& executable) {
  ProcessIdentity result;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return result;
  std::array<wchar_t, 32768> path{};
  DWORD length = static_cast<DWORD>(path.size());
  FILETIME created{}, exited{}, kernel{}, user{};
  result.matches = QueryFullProcessImageNameW(process, 0, path.data(), &length) &&
      CompareStringOrdinal(path.data(), static_cast<int>(length), executable.data(), static_cast<int>(executable.size()), TRUE) == CSTR_EQUAL &&
      GetProcessTimes(process, &created, &exited, &kernel, &user);
  result.created = (static_cast<uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
  CloseHandle(process); return result;
}
BOOL CALLBACK Inspect(HWND window, LPARAM data) noexcept {
  auto* context = reinterpret_cast<InspectionContext*>(data);
  if (context->closed->load()) { context->result->error = ERROR_CANCELLED; return FALSE; }
  try {
    DWORD pid = 0;
    const DWORD thread = GetWindowThreadProcessId(window, &pid);
    if (!pid) return TRUE;
    auto found = context->processes.find(pid);
    if (found == context->processes.end()) found = context->processes.emplace(pid, Identify(pid, *context->executable)).first;
    if (!found->second.matches) return TRUE;
    if (!context->result->title_token.empty()) {
      std::array<wchar_t, 2048> title{};
      const int length = GetWindowTextW(window, title.data(), static_cast<int>(title.size()));
      if (length <= 0 || std::wstring(title.data(), static_cast<size_t>(length)).find(context->result->title_token) == std::wstring::npos) return TRUE;
    }
    ++context->result->matching_windows;
    if (context->result->windows.size() >= kMaxWindows) { context->result->truncated = true; return TRUE; }
    InspectedWindow result;
    result.handle = reinterpret_cast<uintptr_t>(window); result.owner = reinterpret_cast<uintptr_t>(GetWindow(window, GW_OWNER));
    result.process_id = pid; result.thread_id = thread; result.process_created = found->second.created;
    std::array<wchar_t, 256> class_name{};
    const int class_length = GetClassNameW(window, class_name.data(), static_cast<int>(class_name.size()));
    if (class_length > 0) result.window_class.assign(class_name.data(), static_cast<size_t>(class_length));
    result.visible = IsWindowVisible(window) != FALSE; result.minimized = IsIconic(window) != FALSE;
    result.maximized = IsZoomed(window) != FALSE; result.hung = IsHungAppWindow(window) != FALSE;
    result.foreground = GetForegroundWindow() == window;
    WINDOWINFO info{}; info.cbSize = sizeof(info);
    if (GetWindowInfo(window, &info)) { result.rect = info.rcWindow; result.client = info.rcClient; result.style = info.dwStyle; result.extended_style = info.dwExStyle; }
    else result.geometry_error = GetLastError() ? GetLastError() : ERROR_INVALID_WINDOW_HANDLE;
    WINDOWPLACEMENT placement{}; placement.length = sizeof(placement);
    result.placement_available = GetWindowPlacement(window, &placement) != FALSE;
    if (result.placement_available) { result.show_command = placement.showCmd; result.normal = placement.rcNormalPosition; }
    result.dpi = GetDpiForWindow(window);
    result.dpi_awareness = static_cast<int>(GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(window)));
    result.cloak_result = DwmGetWindowAttribute(window, DWMWA_CLOAKED, &result.cloaked, sizeof(result.cloaked));
    result.frame_result = DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &result.frame, sizeof(result.frame));
    if (result.visible && !result.minimized && !result.geometry_error) {
      result.center_hit_sampled = true;
      POINT center{result.rect.left + (result.rect.right - result.rect.left) / 2, result.rect.top + (result.rect.bottom - result.rect.top) / 2};
      const HWND hit = WindowFromPoint(center);
      result.center_within_window = hit && GetAncestor(hit, GA_ROOT) == GetAncestor(window, GA_ROOT);
    }
    DWORD current_pid = 0;
    GetWindowThreadProcessId(window, &current_pid);
    const auto current = Identify(current_pid, *context->executable);
    result.identity_stable = current_pid == pid && current.matches && current.created == result.process_created;
    if (!context->result->title_token.empty()) {
      std::array<wchar_t, 2048> current_title{};
      const int length = GetWindowTextW(window, current_title.data(), static_cast<int>(current_title.size()));
      result.identity_stable = result.identity_stable && length > 0 &&
          std::wstring(current_title.data(), static_cast<size_t>(length)).find(context->result->title_token) != std::wstring::npos;
    }
    context->result->windows.push_back(std::move(result)); return TRUE;
  } catch (...) { context->result->error = ERROR_NOT_ENOUGH_MEMORY; return FALSE; }
}
}

bool InspectApplicationWindows(const std::atomic<bool>& closed, WindowInspection* result, const std::wstring& title_token) {
  *result = WindowInspection{}; result->process_id = GetCurrentProcessId();
  result->title_token = title_token;
  if (closed.load()) { result->error = ERROR_CANCELLED; return false; }
  std::array<wchar_t, 32768> path{}; DWORD length = static_cast<DWORD>(path.size());
  if (!QueryFullProcessImageNameW(GetCurrentProcess(), 0, path.data(), &length)) { result->error = GetLastError(); return false; }
  const std::wstring executable(path.data(), length);
  BOOL composition = FALSE;
  result->composition_result = DwmIsCompositionEnabled(&composition); result->composition_enabled = composition != FALSE;
  InspectionContext context{&executable, &closed, result, {}};
  if (!EnumWindows(Inspect, reinterpret_cast<LPARAM>(&context))) {
    if (!result->error) result->error = GetLastError();
    return false;
  }
  return true;
}

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "window-actions-win.h"
#include <array>
#include <vector>

namespace {
struct Match { HWND window; DWORD pid; FILETIME created; };
struct Lookup { const std::wstring* token; const std::wstring* executable; std::vector<Match> matches; DWORD error = 0; };

bool ProcessMatches(DWORD pid, const std::wstring& executable, FILETIME* created) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return false;
  std::array<wchar_t, 32768> path{};
  DWORD size = static_cast<DWORD>(path.size());
  FILETIME exited{}, kernel{}, user{};
  const bool matches = QueryFullProcessImageNameW(process, 0, path.data(), &size) &&
      CompareStringOrdinal(path.data(), static_cast<int>(size), executable.data(), static_cast<int>(executable.size()), TRUE) == CSTR_EQUAL &&
      GetProcessTimes(process, created, &exited, &kernel, &user);
  CloseHandle(process);
  return matches;
}
BOOL CALLBACK Collect(HWND window, LPARAM value) noexcept {
  auto* lookup = reinterpret_cast<Lookup*>(value);
  try {
    if (!IsWindowVisible(window)) return TRUE;
    std::array<wchar_t, 2048> title{};
    const int length = GetWindowTextW(window, title.data(), static_cast<int>(title.size()));
    if (length <= 0 || std::wstring(title.data(), static_cast<size_t>(length)).find(*lookup->token) == std::wstring::npos) return TRUE;
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    FILETIME created{};
    if (pid && ProcessMatches(pid, *lookup->executable, &created)) lookup->matches.push_back({window, pid, created});
    return TRUE;
  } catch (...) { lookup->error = ERROR_NOT_ENOUGH_MEMORY; return FALSE; }
}
bool StillMatches(const Match& match, const std::wstring& token, const std::wstring& executable) {
  if (!IsWindow(match.window) || !IsWindowVisible(match.window)) return false;
  DWORD pid = 0;
  GetWindowThreadProcessId(match.window, &pid);
  FILETIME created{};
  if (pid != match.pid || !ProcessMatches(pid, executable, &created) || CompareFileTime(&created, &match.created) != 0) return false;
  std::array<wchar_t, 2048> title{};
  const int length = GetWindowTextW(match.window, title.data(), static_cast<int>(title.size()));
  return length > 0 && std::wstring(title.data(), static_cast<size_t>(length)).find(token) != std::wstring::npos;
}
}

bool MaximizeOwnedWindow(const std::wstring& token, const std::atomic<bool>& closed, DWORD* error) {
  const auto fail = [error](DWORD code) { if (error) *error = code; return false; };
  if (error) *error = ERROR_SUCCESS;
  if (token.size() < 16 || token.size() > 128 || token.find(L'\0') != std::wstring::npos) return fail(ERROR_INVALID_PARAMETER);
  std::array<wchar_t, 32768> path{};
  DWORD length = static_cast<DWORD>(path.size());
  if (!QueryFullProcessImageNameW(GetCurrentProcess(), 0, path.data(), &length) || !length || length >= path.size()) return fail(ERROR_BAD_PATHNAME);
  const std::wstring executable(path.data(), length);
  for (unsigned int attempt = 0; attempt < 30; ++attempt) {
    if (closed.load()) return fail(ERROR_CANCELLED);
    Lookup lookup{&token, &executable, {}, 0};
    if (!EnumWindows(Collect, reinterpret_cast<LPARAM>(&lookup))) return fail(lookup.error ? lookup.error : GetLastError());
    if (lookup.matches.size() == 1) {
      const auto match = lookup.matches.front();
      if (closed.load()) return fail(ERROR_CANCELLED);
      if (!StillMatches(match, token, executable)) return fail(ERROR_INVALID_WINDOW_HANDLE);
      if (!ShowWindowAsync(match.window, SW_MAXIMIZE)) return fail(GetLastError() ? GetLastError() : ERROR_INVALID_WINDOW_HANDLE);
      for (unsigned int confirmation = 0; confirmation < 20; ++confirmation) {
        if (closed.load()) return fail(ERROR_CANCELLED);
        if (!StillMatches(match, token, executable)) return fail(ERROR_INVALID_WINDOW_HANDLE);
        if (IsZoomed(match.window)) return true;
        Sleep(50);
      }
      return fail(ERROR_TIMEOUT);
    }
    Sleep(80);
  }
  return fail(ERROR_NOT_FOUND);
}

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shlobj.h>
#include <shellapi.h>
#include <sherrors.h>
#include <objbase.h>
#include <algorithm>
#include <cwchar>
#include <cstring>
#include <new>
#include <mutex>
#include <process.h>
#include <string>
#include <unordered_set>
#include <vector>
#include "shell-context-win.h"
#include "session.h"

namespace {
constexpr UINT_PTR kCancelTimer = 1;
constexpr UINT kCancelCheckMs = 80;
constexpr UINT kFirstCommand = 1;
constexpr UINT kLastCommand = 0x7fff;
constexpr UINT kLockCommand = 0x8000;
constexpr UINT kGitDiffCommand = 0x8001;
constexpr wchar_t kWindowClass[] = L"VisualStudioCodeFileShellMenuOwner";

struct MenuPoint { LONG x; LONG y; };
struct MenuRect { LONG left; LONG top; LONG right; LONG bottom; };

struct NativeError { DWORD code; const char* stage = nullptr; HRESULT hresult = S_OK; };

template <typename T>
class ComOwner {
 public:
  ComOwner() = default;
  explicit ComOwner(T* value) : value_(value) {}
  ComOwner(const ComOwner&) = delete;
  ComOwner& operator=(const ComOwner&) = delete;
  ~ComOwner() { if (value_) value_->Release(); }
  T* get() const { return value_; }
  T** put() { if (value_) { value_->Release(); value_ = nullptr; } return &value_; }
  T* operator->() const { return value_; }
 private:
  T* value_ = nullptr;
};

class PidlOwner {
 public:
  explicit PidlOwner(PIDLIST_ABSOLUTE value = nullptr) : value_(value) {}
  PidlOwner(const PidlOwner&) = delete;
  PidlOwner& operator=(const PidlOwner&) = delete;
  PidlOwner(PidlOwner&& other) noexcept : value_(other.value_) { other.value_ = nullptr; }
  PidlOwner& operator=(PidlOwner&& other) noexcept {
    if (this != &other) { if (value_) CoTaskMemFree(value_); value_ = other.value_; other.value_ = nullptr; }
    return *this;
  }
  ~PidlOwner() { if (value_) CoTaskMemFree(value_); }
  PIDLIST_ABSOLUTE get() const { return value_; }
 private:
  PIDLIST_ABSOLUTE value_;
};

struct Apartment {
  HRESULT status = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  ~Apartment() { if (SUCCEEDED(status)) CoUninitialize(); }
};

struct DpiContext {
  DPI_AWARENESS_CONTEXT previous = nullptr;
  explicit DpiContext(bool enabled) {
    if (enabled) previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  }
  ~DpiContext() { if (previous) SetThreadDpiAwarenessContext(previous); }
};

std::wstring FullPath(const std::wstring& value) {
  if (value.empty() || value.size() > 32760 || value.find(L'\0') != std::wstring::npos) throw NativeError{ERROR_INVALID_PARAMETER};
  const bool drive = value.size() >= 3 && ((value[0] >= L'A' && value[0] <= L'Z') || (value[0] >= L'a' && value[0] <= L'z')) &&
      value[1] == L':' && (value[2] == L'\\' || value[2] == L'/');
  const bool unc = value.size() >= 5 && value[0] == L'\\' && value[1] == L'\\';
  if (!drive && !unc) throw NativeError{ERROR_INVALID_PARAMETER};
  const size_t root_length = drive ? 3 : value.find_first_of(L"\\/", 2);
  if (root_length == std::wstring::npos) throw NativeError{ERROR_INVALID_PARAMETER};
  const size_t root_end = drive ? 3 : value.find_first_of(L"\\/", root_length + 1);
  const size_t first_part = drive ? 3 : (root_end == std::wstring::npos ? value.size() : root_end + 1);
  size_t position = first_part;
  while (position < value.size()) {
    const size_t end = value.find_first_of(L"\\/", position);
    const size_t length = (end == std::wstring::npos ? value.size() : end) - position;
    if (length == 2 && value.compare(position, length, L"..") == 0) throw NativeError{ERROR_INVALID_PARAMETER};
    if (end == std::wstring::npos) break;
    position = end + 1;
  }
  std::vector<wchar_t> buffer(512);
  for (;;) {
    const DWORD count = GetFullPathNameW(value.c_str(), static_cast<DWORD>(buffer.size()), buffer.data(), nullptr);
    if (!count) throw NativeError{GetLastError()};
    if (count < buffer.size()) return std::wstring(buffer.data(), count);
    if (count >= 32767) throw NativeError{ERROR_FILENAME_EXCED_RANGE};
    buffer.resize(static_cast<size_t>(count) + 1);
  }
}

bool EqualPath(const std::wstring& left, const std::wstring& right) {
  return CompareStringOrdinal(left.c_str(), static_cast<int>(left.size()), right.c_str(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}

bool StartsWithPath(const std::wstring& value, const std::wstring& root) {
  if (value.size() <= root.size() || CompareStringOrdinal(value.data(), static_cast<int>(root.size()), root.data(), static_cast<int>(root.size()), TRUE) != CSTR_EQUAL) return false;
  return root.back() == L'\\' || root.back() == L'/' || value[root.size()] == L'\\' || value[root.size()] == L'/';
}

bool NoReparseAncestors(const std::wstring& path) {
  std::wstring current;
  size_t position = 0;
  if (path.size() >= 3 && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')) {
    current = path.substr(0, 3);
    position = 3;
  } else if (path.size() >= 5 && path[0] == L'\\' && path[1] == L'\\') {
    const size_t server = path.find_first_of(L"\\/", 2);
    if (server == std::wstring::npos) return false;
    const size_t share = path.find_first_of(L"\\/", server + 1);
    current = share == std::wstring::npos ? path : path.substr(0, share + 1);
    position = share == std::wstring::npos ? path.size() : share + 1;
  } else return false;
  for (;;) {
    HANDLE handle = CreateFileW(current.c_str(), FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (handle == INVALID_HANDLE_VALUE) return false;
    FILE_ATTRIBUTE_TAG_INFO info{};
    const bool valid = GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info)) != FALSE &&
                       (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
    CloseHandle(handle);
    if (!valid) return false;
    if (position >= path.size()) return true;
    const size_t end = path.find_first_of(L"\\/", position);
    if (current.empty() || (current.back() != L'\\' && current.back() != L'/')) current.push_back(L'\\');
    if (end == std::wstring::npos) current.append(path, position, std::wstring::npos);
    else current.append(path, position, end - position);
    position = end == std::wstring::npos ? path.size() : end + 1;
  }
}

std::vector<std::wstring> ValidateSelection(const ShellContextMenuRequest& request) {
  if ((request.mode != L"inspect" && request.mode != L"show") || request.paths.empty() || request.paths.size() > 256 || request.roots.empty()) throw NativeError{ERROR_INVALID_PARAMETER};
  if (request.owner_title.size() > 1024 || request.lock_inspection_label.size() > 120) throw NativeError{ERROR_INVALID_PARAMETER};
  std::vector<std::wstring> paths;
  std::vector<std::wstring> roots;
  paths.reserve(request.paths.size());
  roots.reserve(request.roots.size());
  for (const auto& root : request.roots) roots.push_back(FullPath(root));
  for (const auto& path : request.paths) paths.push_back(FullPath(path));
  const size_t parent_separator = paths.front().find_last_of(L"\\/");
  const std::wstring parent = parent_separator == std::wstring::npos ? std::wstring() : paths.front().substr(0, parent_separator);
  std::unordered_set<std::wstring> unique;
  for (const auto& path : paths) {
    const size_t separator = path.find_last_of(L"\\/");
    if (separator == std::wstring::npos || !EqualPath(parent, path.substr(0, separator)) || path.substr(separator + 1).find(L':') != std::wstring::npos) throw NativeError{ERROR_INVALID_PARAMETER};
    std::wstring identity = path;
    std::transform(identity.begin(), identity.end(), identity.begin(), towlower);
    if (!unique.insert(std::move(identity)).second) throw NativeError{ERROR_INVALID_PARAMETER};
    bool allowed = false;
    for (const auto& root : roots) if (StartsWithPath(path, root)) { allowed = true; break; }
    if (!allowed || !NoReparseAncestors(path)) throw NativeError{ERROR_ACCESS_DENIED};
    const DWORD attributes = GetFileAttributesW(path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) throw NativeError{GetLastError()};
  }
  return paths;
}

bool ContainsInsensitive(const std::wstring& value, const std::wstring& fragment) {
  if (fragment.empty()) return true;
  if (fragment.size() > value.size()) return false;
  for (size_t index = 0; index + fragment.size() <= value.size(); ++index) {
    if (CompareStringOrdinal(value.data() + index, static_cast<int>(fragment.size()), fragment.data(), static_cast<int>(fragment.size()), TRUE) == CSTR_EQUAL) return true;
  }
  return false;
}

HWND ResolveOwner(const ShellContextMenuRequest& request, MenuPoint* point) {
  HWND owner = GetForegroundWindow();
  DWORD process = 0;
  if (!owner || GetWindowThreadProcessId(owner, &process) == 0) throw NativeError{ERROR_INVALID_WINDOW_HANDLE};
  HANDLE process_handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process);
  if (!process_handle) throw NativeError{GetLastError()};
  wchar_t owner_path[32768]{};
  DWORD owner_path_length = static_cast<DWORD>(std::size(owner_path));
  const BOOL owner_path_ok = QueryFullProcessImageNameW(process_handle, 0, owner_path, &owner_path_length);
  CloseHandle(process_handle);
  wchar_t host_path[32768]{};
  DWORD host_path_length = static_cast<DWORD>(std::size(host_path));
  const BOOL host_path_ok = QueryFullProcessImageNameW(GetCurrentProcess(), 0, host_path, &host_path_length);
  if (!owner_path_ok || !host_path_ok || !host_path_length || owner_path_length >= std::size(owner_path) || host_path_length >= std::size(host_path) ||
      !EqualPath(std::wstring(owner_path, owner_path_length), std::wstring(host_path, host_path_length))) throw NativeError{ERROR_INVALID_WINDOW_HANDLE};
  wchar_t title[1025]{};
  const int length = GetWindowTextW(owner, title, static_cast<int>(std::size(title)));
  if (length < 0 || !ContainsInsensitive(std::wstring(title, static_cast<size_t>(length)), request.owner_title)) throw NativeError{ERROR_INVALID_WINDOW_HANDLE};
  MenuRect bounds{};
  if (!GetWindowRect(owner, reinterpret_cast<RECT*>(&bounds))) throw NativeError{GetLastError()};
  if (request.keyboard) {
    point->x = bounds.left + (bounds.right - bounds.left) / 2;
    point->y = bounds.top + (bounds.bottom - bounds.top) / 2;
  } else {
    POINT cursor{};
    if (!GetCursorPos(&cursor) || cursor.x < bounds.left || cursor.x >= bounds.right || cursor.y < bounds.top || cursor.y >= bounds.bottom) throw NativeError{ERROR_INVALID_WINDOW_HANDLE};
    point->x = cursor.x; point->y = cursor.y;
  }
  return owner;
}

class MenuWindow {
 public:
  MenuWindow(HWND owner, IContextMenu2* second, IContextMenu3* third, const std::atomic<bool>* session_closed)
      : second_(second), third_(third), session_closed_(session_closed) {
    static std::once_flag registered;
    static DWORD registration_error = ERROR_SUCCESS;
    std::call_once(registered, [] {
      WNDCLASSEXW definition{};
      definition.cbSize = sizeof(definition);
      definition.lpfnWndProc = Procedure;
      definition.hInstance = GetModuleHandleW(nullptr);
      definition.lpszClassName = kWindowClass;
      if (!RegisterClassExW(&definition) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) registration_error = GetLastError();
    });
    if (registration_error != ERROR_SUCCESS) throw NativeError{registration_error};
    window_ = CreateWindowExW(WS_EX_TOOLWINDOW, kWindowClass, L"", WS_POPUP,
        0, 0, 0, 0, owner, nullptr, GetModuleHandleW(nullptr), this);
    if (!window_) throw NativeError{GetLastError()};
    if (!SetTimer(window_, kCancelTimer, kCancelCheckMs, nullptr)) {
      const DWORD error = GetLastError();
      DestroyWindow(window_);
      window_ = nullptr;
      throw NativeError{error};
    }
  }
  MenuWindow(const MenuWindow&) = delete;
  MenuWindow& operator=(const MenuWindow&) = delete;
  ~MenuWindow() { if (window_) DestroyWindow(window_); }
  HWND get() const { return window_; }

 private:
  static LRESULT CALLBACK Procedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    auto* self = reinterpret_cast<MenuWindow*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
      auto* create = reinterpret_cast<CREATESTRUCTW*>(lparam);
      self = static_cast<MenuWindow*>(create->lpCreateParams);
      SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
    }
    if (!self) return DefWindowProcW(window, message, wparam, lparam);
    if (message == WM_TIMER && wparam == kCancelTimer) {
      if (self->session_closed_->load()) EndMenu();
      return 0;
    }
    if (message == WM_INITMENUPOPUP || message == WM_DRAWITEM || message == WM_MEASUREITEM || message == WM_MENUCHAR) {
      LRESULT result = 0;
      if (RelayShellMenuMessage(self->second_, self->third_, message, wparam, lparam, &result)) return result;
    }
    return DefWindowProcW(window, message, wparam, lparam);
  }
  HWND window_ = nullptr;
  IContextMenu2* second_;
  IContextMenu3* third_;
  const std::atomic<bool>* session_closed_;
};

bool IsDirectory(const std::wstring& path) {
  const DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

std::unordered_set<HWND> VisibleWindows() {
  std::unordered_set<HWND> windows;
  EnumWindows([](HWND window, LPARAM parameter) -> BOOL {
    DWORD process = 0;
    GetWindowThreadProcessId(window, &process);
    if (process == GetCurrentProcessId() && IsWindowVisible(window)) reinterpret_cast<std::unordered_set<HWND>*>(parameter)->insert(window);
    return TRUE;
  }, reinterpret_cast<LPARAM>(&windows));
  return windows;
}

bool HasNewVisibleWindow(const std::unordered_set<HWND>& baseline) {
  const auto current = VisibleWindows();
  for (HWND window : current) if (baseline.find(window) == baseline.end()) return true;
  return false;
}

void PumpMessages() {
  MSG message{};
  while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
}

void RunMenu(const ShellContextMenuRequest& request, const std::vector<std::wstring>& paths,
             const std::atomic<bool>& session_closed, ShellContextMenuResult* result) {
  DpiContext dpi(request.mode == L"show");
  MenuPoint point{};
  HWND owner = request.mode == L"show" ? ResolveOwner(request, &point) : nullptr;
  std::vector<PidlOwner> pidls;
  std::vector<PCUITEMID_CHILD> children;
  pidls.reserve(paths.size()); children.reserve(paths.size());
  for (const auto& path : paths) {
    PIDLIST_ABSOLUTE raw = nullptr;
    SFGAOF attributes = 0;
    const HRESULT parsed = SHParseDisplayName(path.c_str(), nullptr, &raw, 0, &attributes);
    if (FAILED(parsed) || !raw) throw NativeError{FAILED(parsed) ? static_cast<DWORD>(HRESULT_CODE(parsed)) : ERROR_INVALID_DATA, "SHParseDisplayName", parsed};
    pidls.emplace_back(raw);
    children.push_back(ILFindLastID(raw));
  }
  ComOwner<IShellFolder> folder;
  PCUITEMID_CHILD first_child = nullptr;
  const HRESULT bound = SHBindToParent(pidls.front().get(), IID_PPV_ARGS(folder.put()), &first_child);
  if (FAILED(bound) || !folder.get()) throw NativeError{FAILED(bound) ? static_cast<DWORD>(HRESULT_CODE(bound)) : ERROR_INVALID_DATA, "SHBindToParent", bound};
  ComOwner<IContextMenu> context;
  const HRESULT queried = folder->GetUIObjectOf(nullptr, static_cast<UINT>(children.size()), children.data(), IID_IContextMenu, nullptr, reinterpret_cast<void**>(context.put()));
  if (FAILED(queried) || !context.get()) throw NativeError{FAILED(queried) ? static_cast<DWORD>(HRESULT_CODE(queried)) : ERROR_INVALID_DATA, "IShellFolder.GetUIObjectOf", queried};
  ComOwner<IContextMenu2> second;
  ComOwner<IContextMenu3> third;
  context->QueryInterface(IID_PPV_ARGS(second.put()));
  context->QueryInterface(IID_PPV_ARGS(third.put()));
  result->context_menu2 = second.get() != nullptr;
  result->context_menu3 = third.get() != nullptr;
  HMENU menu = CreatePopupMenu();
  if (!menu) throw NativeError{GetLastError()};
  struct MenuGuard { HMENU value; ~MenuGuard() { if (value) DestroyMenu(value); } } menu_guard{menu};
  const HRESULT populated = context->QueryContextMenu(menu, 0, kFirstCommand, kLastCommand, CMF_EXPLORE);
  if (FAILED(populated)) throw NativeError{static_cast<DWORD>(HRESULT_CODE(populated)), "IContextMenu.QueryContextMenu", populated};
  const bool inspect_folder = paths.size() == 1 && IsDirectory(paths.front());
  if (inspect_folder && (!AppendMenuW(menu, MF_SEPARATOR, 0, nullptr) ||
      !AppendMenuW(menu, MF_STRING, kLockCommand, request.lock_inspection_label.c_str()))) throw NativeError{GetLastError()};
  DWORD menu_error = ERROR_SUCCESS;
  const bool git_diff = request.git_diff && paths.size() == 1 && !IsDirectory(paths.front());
  if (!AppendGitDiffMenu(menu, git_diff, &menu_error)) throw NativeError{menu_error};
  if (!EnumerateShellMenu(menu, context.get(), &result->entries, &menu_error)) throw NativeError{menu_error};
  if (request.mode == L"inspect") return;
  MenuWindow window(owner, second.get(), third.get(), &session_closed);
  MenuPoint verified_point{};
  if (ResolveOwner(request, &verified_point) != owner) throw NativeError{ERROR_INVALID_WINDOW_HANDLE};
  point = verified_point;
  result->displayed = true;
  const UINT command = TrackPopupMenuEx(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, point.x, point.y, window.get(), nullptr);
  result->cancelled = command == 0;
  if (session_closed.load()) throw NativeError{ERROR_CANCELLED};
  if (SelectGitDiffMenuCommand(command, git_diff, result)) return;
  if (command == kLockCommand && inspect_folder) {
    result->inspect_locks = true;
    result->invoked = true;
    return;
  }
  PostMessageW(owner, WM_NULL, 0, 0);
  if (command != 0) {
    ValidateSelection(request);
    const auto baseline = VisibleWindows();
    CMINVOKECOMMANDINFOEX invoke{};
    invoke.cbSize = sizeof(invoke);
    invoke.fMask = CMIC_MASK_UNICODE | CMIC_MASK_PTINVOKE;
    invoke.hwnd = owner;
    invoke.lpVerb = MAKEINTRESOURCEA(command - kFirstCommand);
    invoke.lpVerbW = MAKEINTRESOURCEW(command - kFirstCommand);
    invoke.nShow = SW_SHOWNORMAL;
    invoke.ptInvoke.x = point.x;
    invoke.ptInvoke.y = point.y;
    const HRESULT invoked = InvokeShellMenuCommand(context.get(), reinterpret_cast<LPCMINVOKECOMMANDINFO>(&invoke), result);
    if (FAILED(invoked)) throw NativeError{static_cast<DWORD>(HRESULT_CODE(invoked)), "IContextMenu.InvokeCommand", invoked};
    while (!result->cancelled && HasNewVisibleWindow(baseline) && !session_closed.load()) {
      PumpMessages();
      Sleep(25);
    }
    if (session_closed.load()) throw NativeError{ERROR_CANCELLED};
  }
}
std::atomic<bool> g_menu_active{false};
bool PinModule() {
  static std::once_flag once;
  static bool pinned = false;
  std::call_once(once, [] {
    HMODULE module = nullptr;
    pinned = GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
        reinterpret_cast<LPCWSTR>(&ResolveShellContextMenu), &module) != FALSE;
  });
  return pinned;
}
}

bool ResolveShellContextMenu(const ShellContextMenuRequest& request,
                             const std::atomic<bool>& session_closed,
                             ShellContextMenuResult* result,
                             DWORD* native_error) {
  if (native_error) *native_error = ERROR_SUCCESS;
  if (!result) { if (native_error) *native_error = ERROR_INVALID_PARAMETER; return false; }
  *result = ShellContextMenuResult{};
  try {
    if (session_closed.load()) throw NativeError{ERROR_CANCELLED};
    const auto paths = ValidateSelection(request);
    Apartment apartment;
    if (FAILED(apartment.status)) throw NativeError{ERROR_INVALID_STATE};
    const ULONGLONG started = GetTickCount64();
    RunMenu(request, paths, session_closed, result);
    const ULONGLONG elapsed = GetTickCount64() - started;
    result->native_milliseconds = elapsed > MAXDWORD ? MAXDWORD : static_cast<DWORD>(elapsed);
    return true;
  } catch (const NativeError& error) {
    auto command_verb = std::move(result->command_verb);
    const UINT command_id = result->command_id;
    *result = ShellContextMenuResult{};
    result->command_verb = std::move(command_verb);
    result->command_id = command_id;
    result->error_stage = error.stage;
    result->error_hresult = error.hresult;
    if (native_error) *native_error = error.code ? error.code : ERROR_GEN_FAILURE;
  } catch (const std::bad_alloc&) {
    *result = ShellContextMenuResult{};
    if (native_error) *native_error = ERROR_NOT_ENOUGH_MEMORY;
  } catch (...) {
    *result = ShellContextMenuResult{};
    if (native_error) *native_error = ERROR_GEN_FAILURE;
  }
  return false;
}

HRESULT InvokeShellMenuCommand(IContextMenu* context, LPCMINVOKECOMMANDINFO command,
                              ShellContextMenuResult* result) {
  result->command_id = static_cast<UINT>(reinterpret_cast<UINT_PTR>(command->lpVerb));
  wchar_t verb[257]{};
  if (SUCCEEDED(context->GetCommandString(result->command_id, GCS_VERBW, nullptr,
      reinterpret_cast<LPSTR>(verb), static_cast<UINT>(std::size(verb))))) result->command_verb.assign(verb, wcsnlen_s(verb, std::size(verb)));
  const HRESULT status = context->InvokeCommand(command);
  if (status == E_ABORT || status == HRESULT_FROM_WIN32(ERROR_CANCELLED) || status == COPYENGINE_E_USER_CANCELLED) {
    result->cancelled = true;
    result->refresh_required = true;
    return S_OK;
  }
  if (SUCCEEDED(status)) result->invoked = true;
  return status;
}

bool AppendGitDiffMenu(HMENU menu, bool enabled, DWORD* native_error) {
  if (native_error) *native_error = ERROR_SUCCESS;
  if (!enabled) return true;
  HMENU submenu = CreatePopupMenu();
  if (!submenu) { if (native_error) *native_error = GetLastError(); return false; }
  if (!AppendMenuW(submenu, MF_STRING, kGitDiffCommand, L"Diff") ||
      !AppendMenuW(menu, MF_SEPARATOR, 0, nullptr) ||
      !AppendMenuW(menu, MF_POPUP, reinterpret_cast<UINT_PTR>(submenu), L"Git")) {
    if (native_error) *native_error = GetLastError();
    DestroyMenu(submenu);
    return false;
  }
  return true;
}

bool SelectGitDiffMenuCommand(UINT command, bool enabled, ShellContextMenuResult* result) {
  if (!enabled || command != kGitDiffCommand || !result) return false;
  result->git_diff = true;
  result->invoked = true;
  result->cancelled = false;
  return true;
}

bool EnumerateShellMenu(HMENU menu, IContextMenu* context,
                       std::vector<ShellContextMenuEntry>* entries,
                       DWORD* native_error) {
  if (native_error) *native_error = ERROR_SUCCESS;
  if (!menu || !context || !entries) { if (native_error) *native_error = ERROR_INVALID_PARAMETER; return false; }
  try {
    const int count = GetMenuItemCount(menu);
    if (count < 0) { if (native_error) *native_error = GetLastError(); return false; }
    std::vector<ShellContextMenuEntry> parsed;
    parsed.reserve(static_cast<size_t>(count));
    for (int index = 0; index < count; ++index) {
      wchar_t label[2049]{};
      const int length = GetMenuStringW(menu, static_cast<UINT>(index), label, static_cast<int>(std::size(label)), MF_BYPOSITION);
      if (length <= 0) continue;
      ShellContextMenuEntry entry;
      entry.label.assign(label, static_cast<size_t>(length));
      const UINT command = GetMenuItemID(menu, index);
      if (command >= kFirstCommand && command <= kLastCommand) {
        wchar_t verb[257]{};
        if (SUCCEEDED(context->GetCommandString(static_cast<UINT_PTR>(command - kFirstCommand), GCS_VERBW,
            nullptr, reinterpret_cast<LPSTR>(verb), static_cast<UINT>(std::size(verb))))) entry.verb = verb;
      }
      entry.submenu = GetSubMenu(menu, index) != nullptr;
      parsed.push_back(std::move(entry));
    }
    *entries = std::move(parsed);
    return true;
  } catch (const std::bad_alloc&) {
    if (native_error) *native_error = ERROR_NOT_ENOUGH_MEMORY;
  } catch (...) {
    if (native_error) *native_error = ERROR_GEN_FAILURE;
  }
  return false;
}

bool RelayShellMenuMessage(IContextMenu2* second, IContextMenu3* third,
                           UINT message, WPARAM wparam, LPARAM lparam,
                           LRESULT* result) {
  if (message != WM_INITMENUPOPUP && message != WM_DRAWITEM && message != WM_MEASUREITEM && message != WM_MENUCHAR) return false;
  if (third) {
    LRESULT value = 0;
    if (SUCCEEDED(third->HandleMenuMsg2(message, wparam, lparam, &value))) {
      if (result) *result = value;
      return true;
    }
  }
  if (second && SUCCEEDED(second->HandleMenuMsg(message, wparam, lparam))) {
    if (result) *result = 0;
    return true;
  }
  return false;
}

namespace {
struct MenuJob {
  std::shared_ptr<SessionState> state;
  ShellContextMenuRequest request;
  ShellContextMenuResult result;
  DWORD native_error = ERROR_SUCCESS;
  napi_deferred deferred = nullptr;
  napi_threadsafe_function completion = nullptr;
  HANDLE thread_handle = nullptr;
  std::atomic<bool> start_ready{false};
};

napi_value Throw(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message);
  return nullptr;
}

bool ReadWide(napi_env env, napi_value object, const char* name, size_t limit,
              std::wstring* result, bool optional = false) {
  bool has = false;
  if (napi_has_named_property(env, object, name, &has) != napi_ok) return false;
  if (!has) return optional;
  napi_value value;
  napi_valuetype type;
  size_t length = 0;
  if (napi_get_named_property(env, object, name, &value) != napi_ok ||
      napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || length > limit) return false;
  std::vector<char16_t> buffer(length + 1);
  if (napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
  result->assign(reinterpret_cast<const wchar_t*>(buffer.data()), length);
  return result->find(L'\0') == std::wstring::npos;
}

bool ReadStringArray(napi_env env, napi_value object, const char* name,
                     size_t max_count, std::vector<std::wstring>* values) {
  napi_value array;
  bool is_array = false;
  uint32_t length = 0;
  if (napi_get_named_property(env, object, name, &array) != napi_ok ||
      napi_is_array(env, array, &is_array) != napi_ok || !is_array ||
      napi_get_array_length(env, array, &length) != napi_ok || length == 0 || length > max_count) return false;
  values->reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value value;
    size_t size = 0;
    if (napi_get_element(env, array, index, &value) != napi_ok ||
        napi_get_value_string_utf16(env, value, nullptr, 0, &size) != napi_ok || size == 0 || size > 32760) return false;
    std::vector<char16_t> buffer(size + 1);
    if (napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &size) != napi_ok) return false;
    std::wstring path(reinterpret_cast<const wchar_t*>(buffer.data()), size);
    if (path.find(L'\0') != std::wstring::npos) return false;
    values->push_back(std::move(path));
  }
  return true;
}

bool ParseRequest(napi_env env, napi_value value, ShellContextMenuRequest* request) {
  napi_valuetype type;
  napi_value null_value;
  bool is_null = false, is_array = false;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_object ||
      napi_get_null(env, &null_value) != napi_ok || napi_strict_equals(env, value, null_value, &is_null) != napi_ok || is_null ||
      napi_is_array(env, value, &is_array) != napi_ok || is_array) return false;
  if (!ReadWide(env, value, "mode", 8, &request->mode) ||
      !ReadStringArray(env, value, "paths", 256, &request->paths) ||
      !ReadStringArray(env, value, "roots", 256, &request->roots) ||
      !ReadWide(env, value, "ownerTitle", 1024, &request->owner_title, true)) return false;
  std::wstring label;
  if (!ReadWide(env, value, "lockInspectionLabel", 120, &label, true)) return false;
  request->lock_inspection_label = label.empty() ? L"Ordnersperren untersuchen" : std::move(label);
  bool has_git_diff = false;
  if (napi_has_named_property(env, value, "gitDiff", &has_git_diff) != napi_ok) return false;
  if (has_git_diff) {
    napi_value git_diff;
    if (napi_get_named_property(env, value, "gitDiff", &git_diff) != napi_ok ||
        napi_get_value_bool(env, git_diff, &request->git_diff) != napi_ok) return false;
  }
  bool has_keyboard = false;
  if (napi_has_named_property(env, value, "keyboard", &has_keyboard) != napi_ok) return false;
  if (has_keyboard) {
    napi_value keyboard;
    if (napi_get_named_property(env, value, "keyboard", &keyboard) != napi_ok ||
        napi_get_value_bool(env, keyboard, &request->keyboard) != napi_ok) return false;
  }
  return request->mode == L"inspect" || request->mode == L"show";
}

const char* ErrorCode(DWORD error) {
  switch (error) {
    case ERROR_INVALID_PARAMETER: return "InvalidRequest";
    case ERROR_ACCESS_DENIED: return "AccessDenied";
    case ERROR_CANCELLED: return "Cancelled";
    case ERROR_FILE_NOT_FOUND: case ERROR_PATH_NOT_FOUND: return "NotFound";
    case ERROR_INVALID_WINDOW_HANDLE: return "WindowUnavailable";
    default: return "NativeFailure";
  }
}

napi_value WideValue(napi_env env, const std::wstring& value) {
  napi_value result;
  if (napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(value.data()), value.size(), &result) != napi_ok) return nullptr;
  return result;
}

bool Set(napi_env env, napi_value object, const char* name, napi_value value) {
  return value && napi_set_named_property(env, object, name, value) == napi_ok;
}

napi_value ResultValue(napi_env env, const ShellContextMenuResult& result) {
  napi_value output, entries, interfaces, timing, value;
  if (napi_create_object(env, &output) != napi_ok || napi_create_array_with_length(env, result.entries.size(), &entries) != napi_ok ||
      napi_create_object(env, &interfaces) != napi_ok || napi_create_object(env, &timing) != napi_ok) return nullptr;
  if (!Set(env, output, "ok", (napi_get_boolean(env, true, &value) == napi_ok) ? value : nullptr) ||
      !Set(env, output, "displayed", (napi_get_boolean(env, result.displayed, &value) == napi_ok) ? value : nullptr) ||
      !Set(env, output, "invoked", (napi_get_boolean(env, result.invoked, &value) == napi_ok) ? value : nullptr) ||
      !Set(env, output, "cancelled", (napi_get_boolean(env, result.cancelled, &value) == napi_ok) ? value : nullptr) ||
      !Set(env, interfaces, "contextMenu2", (napi_get_boolean(env, result.context_menu2, &value) == napi_ok) ? value : nullptr) ||
      !Set(env, interfaces, "contextMenu3", (napi_get_boolean(env, result.context_menu3, &value) == napi_ok) ? value : nullptr)) return nullptr;
  for (size_t index = 0; index < result.entries.size(); ++index) {
    napi_value entry, submenu;
    if (napi_create_object(env, &entry) != napi_ok || napi_get_boolean(env, result.entries[index].submenu, &submenu) != napi_ok ||
        !Set(env, entry, "label", WideValue(env, result.entries[index].label)) ||
        !Set(env, entry, "verb", WideValue(env, result.entries[index].verb)) ||
        !Set(env, entry, "submenu", submenu) || napi_set_element(env, entries, static_cast<uint32_t>(index), entry) != napi_ok) return nullptr;
  }
  if (napi_create_uint32(env, result.native_milliseconds, &value) != napi_ok || !Set(env, timing, "nativeMilliseconds", value) ||
      !Set(env, output, "entries", entries) || !Set(env, output, "interfaces", interfaces) || !Set(env, output, "timing", timing)) return nullptr;
  if (result.inspect_locks && !Set(env, output, "action", WideValue(env, L"inspect-locks"))) return nullptr;
  if (result.git_diff && !Set(env, output, "action", WideValue(env, L"git-diff"))) return nullptr;
  if (result.refresh_required && !Set(env, output, "refreshRequired", (napi_get_boolean(env, true, &value) == napi_ok) ? value : nullptr)) return nullptr;
  return output;
}

void Reject(napi_env env, MenuJob* job, const char* code) {
  napi_value message, error, code_value, operation, native;
  if (napi_create_string_utf8(env, "Native shell context menu failed.", NAPI_AUTO_LENGTH, &message) != napi_ok ||
      napi_create_error(env, nullptr, message, &error) != napi_ok ||
      napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) != napi_ok ||
      napi_create_string_utf8(env, "shell.showContextMenu", NAPI_AUTO_LENGTH, &operation) != napi_ok ||
      napi_create_uint32(env, job->native_error, &native) != napi_ok) return;
  napi_set_named_property(env, error, "code", code_value);
  napi_set_named_property(env, error, "operation", operation);
  napi_set_named_property(env, error, "nativeCode", native);
  if (job->result.error_stage) {
    napi_value stage;
    if (napi_create_string_utf8(env, job->result.error_stage, NAPI_AUTO_LENGTH, &stage) == napi_ok) napi_set_named_property(env, error, "nativeStage", stage);
  }
  if (FAILED(job->result.error_hresult)) {
    wchar_t hex[11]{};
    swprintf_s(hex, L"0x%08lX", static_cast<unsigned long>(job->result.error_hresult));
    Set(env, error, "hresult", WideValue(env, hex));
  }
  if (job->result.error_stage && std::strcmp(job->result.error_stage, "IContextMenu.InvokeCommand") == 0) {
    if (!job->result.command_verb.empty()) Set(env, error, "nativeCommand", WideValue(env, job->result.command_verb));
    napi_value command_id;
    if (napi_create_uint32(env, job->result.command_id, &command_id) == napi_ok) napi_set_named_property(env, error, "nativeCommandId", command_id);
  }
  napi_reject_deferred(env, job->deferred, error);
}

void CallJs(napi_env env, napi_value, void*, void* data) {
  std::unique_ptr<MenuJob> job(static_cast<MenuJob*>(data));
  if (!env) return;
  if (job->state->closed.load()) { Reject(env, job.get(), "SessionClosed"); return; }
  if (job->native_error != ERROR_SUCCESS) { Reject(env, job.get(), ErrorCode(job->native_error)); return; }
  napi_value result = ResultValue(env, job->result);
  if (result) napi_resolve_deferred(env, job->deferred, result);
  else Reject(env, job.get(), "BindingFailure");
}

unsigned __stdcall MenuThread(void* argument) {
  auto* job = static_cast<MenuJob*>(argument);
  while (!job->start_ready.load(std::memory_order_acquire)) SwitchToThread();
  const HANDLE thread_handle = job->thread_handle;
  const napi_threadsafe_function completion = job->completion;
  if (!ResolveShellContextMenu(job->request, job->state->closed, &job->result, &job->native_error) &&
      job->native_error == ERROR_SUCCESS) job->native_error = ERROR_GEN_FAILURE;
  g_menu_active.store(false);
  const napi_status queued = napi_call_threadsafe_function(completion, job, napi_tsfn_nonblocking);
  napi_release_threadsafe_function(completion, napi_tsfn_release);
  if (queued != napi_ok) delete job;
  CloseHandle(thread_handle);
  return 0;
}
}

napi_value StartNativeShellContextMenu(napi_env env,
                                       const std::shared_ptr<SessionState>& state,
                                       napi_value request_value) {
  try {
    if (!PinModule()) return Throw(env, "NativeFailure", "Cannot retain the native shell menu module.");
    auto job = std::make_unique<MenuJob>();
    job->state = state;
    if (!ParseRequest(env, request_value, &job->request)) return Throw(env, "InvalidRequest", "A valid native shell menu request is required.");
    bool expected = false;
    if (!g_menu_active.compare_exchange_strong(expected, true)) return Throw(env, "Busy", "A native shell menu is already active.");
    napi_value promise, resource;
    if (napi_create_promise(env, &job->deferred, &promise) != napi_ok ||
        napi_create_string_utf8(env, "shell.showContextMenu", NAPI_AUTO_LENGTH, &resource) != napi_ok ||
        napi_create_threadsafe_function(env, nullptr, nullptr, resource, 1, 1, nullptr, nullptr, nullptr, CallJs, &job->completion) != napi_ok) {
      g_menu_active.store(false);
      return Throw(env, "BindingFailure", "Cannot create native shell menu completion.");
    }
    MenuJob* raw_job = job.get();
    uintptr_t thread = _beginthreadex(nullptr, 0, MenuThread, raw_job, 0, nullptr);
    if (!thread) {
      g_menu_active.store(false);
      napi_release_threadsafe_function(job->completion, napi_tsfn_abort);
      napi_value message, error, code;
      napi_create_string_utf8(env, "Cannot start native shell menu work.", NAPI_AUTO_LENGTH, &message);
      napi_create_error(env, nullptr, message, &error);
      napi_create_string_utf8(env, "ResourceExhausted", NAPI_AUTO_LENGTH, &code);
      napi_set_named_property(env, error, "code", code);
      napi_reject_deferred(env, job->deferred, error);
      return promise;
    }
    raw_job->thread_handle = reinterpret_cast<HANDLE>(thread);
    job.release();
    raw_job->start_ready.store(true, std::memory_order_release);
    return promise;
  } catch (const std::bad_alloc&) {
    return Throw(env, "ResourceExhausted", "Cannot allocate native shell menu work.");
  } catch (...) {
    return Throw(env, "NativeFailure", "Cannot initialize native shell menu work.");
  }
}

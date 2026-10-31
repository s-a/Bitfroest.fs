#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define NAPI_VERSION 8
#include <node_api.h>
#include <windows.h>
#include <tlhelp32.h>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {
struct WindowState {
  std::mutex mutex;
  std::condition_variable changed;
  std::thread thread;
  std::wstring class_name;
  std::wstring title;
  HMODULE module = nullptr;
  HWND window = nullptr;
  DWORD thread_id = 0;
  DWORD error = ERROR_SUCCESS;
  bool queue_ready = false;
  bool initialized = false;
  bool failed = false;
  bool stop_requested = false;
  bool exited = false;
};

struct EnvironmentState {
  std::mutex mutex;
  std::shared_ptr<WindowState> window;
};

std::atomic<uint64_t> next_window_id{1};

HMODULE PinModuleForWindowThread() {
  static std::once_flag once;
  static HMODULE module = nullptr;
  std::call_once(once, [] {
    HMODULE pinned_module = nullptr;
    if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
        reinterpret_cast<LPCWSTR>(&PinModuleForWindowThread), &pinned_module)) {
      module = pinned_module;
    }
  });
  return module;
}

napi_value Throw(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message);
  return nullptr;
}

bool ReadToken(napi_env env, napi_value value, std::wstring* token) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || length == 0 || length > 128) return false;
  try {
    std::vector<char16_t> buffer(length + 1);
    if (napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
    token->assign(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(length));
    if (token->find(L'\0') != std::wstring::npos) return false;
    for (wchar_t ch : *token) if (ch < 0x20 || ch == 0x7f) return false;
    return true;
  } catch (...) { return false; }
}

void SignalInitialization(const std::shared_ptr<WindowState>& state, bool failed, DWORD error, HWND window = nullptr) {
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    state->window = window;
    state->failed = failed;
    state->error = error;
    state->initialized = true;
  }
  state->changed.notify_all();
}

bool StopRequested(const std::shared_ptr<WindowState>& state) {
  std::lock_guard<std::mutex> lock(state->mutex);
  return state->stop_requested;
}

LRESULT CALLBACK FixtureWindowProcedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcW(window, message, wparam, lparam);
}

void WindowThreadMain(std::shared_ptr<WindowState> state) noexcept {
  MSG queue_message{};
  PeekMessageW(&queue_message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    state->thread_id = GetCurrentThreadId();
    state->queue_ready = true;
  }
  state->changed.notify_all();
  if (StopRequested(state)) {
    SignalInitialization(state, true, ERROR_CANCELLED);
    return;
  }

  WNDCLASSEXW window_class{};
  window_class.cbSize = sizeof(window_class);
  window_class.style = CS_HREDRAW | CS_VREDRAW;
  window_class.lpfnWndProc = FixtureWindowProcedure;
  window_class.hInstance = state->module;
  window_class.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512));
  window_class.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
  window_class.lpszClassName = state->class_name.c_str();
  if (!RegisterClassExW(&window_class)) {
    SignalInitialization(state, true, GetLastError());
    return;
  }

  if (StopRequested(state)) {
    UnregisterClassW(state->class_name.c_str(), state->module);
    SignalInitialization(state, true, ERROR_CANCELLED);
    return;
  }

  HWND window = CreateWindowExW(0, state->class_name.c_str(), state->title.c_str(), WS_OVERLAPPEDWINDOW | WS_VISIBLE,
      CW_USEDEFAULT, CW_USEDEFAULT, 640, 480, nullptr, nullptr, state->module, nullptr);
  if (!window) {
    const DWORD error = GetLastError();
    UnregisterClassW(state->class_name.c_str(), state->module);
    SignalInitialization(state, true, error);
    return;
  }
  ShowWindow(window, SW_SHOWNORMAL);
  UpdateWindow(window);
  const bool stop_after_create = StopRequested(state);
  SignalInitialization(state, false, ERROR_SUCCESS, window);
  if (stop_after_create) PostMessageW(window, WM_CLOSE, 0, 0);

  MSG message{};
  int result = 0;
  while ((result = GetMessageW(&message, nullptr, 0, 0)) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  if (result == -1 && GetLastError() != ERROR_SUCCESS) {
    std::lock_guard<std::mutex> lock(state->mutex);
    state->error = GetLastError();
  }
  if (IsWindow(window)) DestroyWindow(window);
  UnregisterClassW(state->class_name.c_str(), state->module);
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    state->window = nullptr;
    state->exited = true;
  }
  state->changed.notify_all();
}

void CloseWindowInternal(const std::shared_ptr<WindowState>& state) noexcept {
  if (!state) return;
  HWND window = nullptr;
  DWORD thread_id = 0;
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    state->stop_requested = true;
    window = state->window;
    thread_id = state->thread_id;
  }
  if (window && !PostMessageW(window, WM_CLOSE, 0, 0) && thread_id) PostThreadMessageW(thread_id, WM_QUIT, 0, 0);
  else if (!window && thread_id) PostThreadMessageW(thread_id, WM_QUIT, 0, 0);
  try {
    if (state->thread.joinable() && state->thread.get_id() != std::this_thread::get_id()) state->thread.join();
  } catch (...) {}
}

void FinalizeEnvironment(void* data) {
  std::unique_ptr<EnvironmentState> environment(static_cast<EnvironmentState*>(data));
  std::shared_ptr<WindowState> window;
  {
    std::lock_guard<std::mutex> lock(environment->mutex);
    window = std::move(environment->window);
  }
  CloseWindowInternal(window);
}

napi_value StartWindow(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  void* callback_data = nullptr;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, &callback_data) != napi_ok || argc != 1) return Throw(env, "InvalidRequest", "A unique window title token is required.");
  std::wstring token;
  if (!ReadToken(env, args[0], &token)) return Throw(env, "InvalidRequest", "The window title token must be a non-empty string of at most 128 characters.");
  auto* environment = static_cast<EnvironmentState*>(callback_data);
  if (!environment) return Throw(env, "NativeFailure", "The window fixture environment is unavailable.");
  std::unique_lock<std::mutex> lock(environment->mutex);
  if (environment->window) return Throw(env, "WindowAlreadyStarted", "The fixture window is already started.");
  const HMODULE module = PinModuleForWindowThread();
  if (!module) return Throw(env, "NativeFailure", "The native module could not be retained for the window thread.");

  std::shared_ptr<WindowState> state;
  try {
    state = std::make_shared<WindowState>();
    const uint64_t id = next_window_id.fetch_add(1);
    state->module = module;
    state->class_name = L"VSCodeNativeWindowFixture-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(id);
    state->title = L"VS Code Native Window Fixture [" + token + L"]";
  } catch (...) {
    return Throw(env, "ResourceExhausted", "The fixture window state could not be allocated.");
  }
  environment->window = state;
  try {
    state->thread = std::thread(WindowThreadMain, state);
  } catch (...) {
    environment->window.reset();
    return Throw(env, "NativeFailure", "The fixture message-pump thread could not be created.");
  }
  lock.unlock();

  bool initialized = false;
  bool failed = false;
  DWORD error = ERROR_SUCCESS;
  {
    std::unique_lock<std::mutex> state_lock(state->mutex);
    initialized = state->changed.wait_for(state_lock, std::chrono::seconds(5), [&] { return state->initialized; });
    failed = state->failed;
    error = state->error;
  }
  if (!initialized || failed) {
    CloseWindowInternal(state);
    std::lock_guard<std::mutex> environment_lock(environment->mutex);
    if (environment->window == state) environment->window.reset();
    return Throw(env, !initialized ? "WindowStartTimeout" : "WindowCreateFailed",
                 !initialized ? "The fixture window was not initialized within five seconds." : "The fixture window could not be created.");
  }

  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return Throw(env, "NativeFailure", "The fixture window was created but the result could not be returned.");
  return result;
}

napi_value IsMaximized(napi_env env, napi_callback_info info) {
  void* callback_data = nullptr;
  if (napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &callback_data) != napi_ok) return Throw(env, "NativeFailure", "The window fixture state could not be read.");
  auto* environment = static_cast<EnvironmentState*>(callback_data);
  if (!environment) return Throw(env, "NativeFailure", "The window fixture environment is unavailable.");
  std::shared_ptr<WindowState> state;
  {
    std::lock_guard<std::mutex> lock(environment->mutex);
    state = environment->window;
  }
  HWND window = nullptr;
  DWORD expected_thread = 0;
  if (state) {
    std::lock_guard<std::mutex> lock(state->mutex);
    window = state->window;
    expected_thread = state->thread_id;
  }
  DWORD process_id = 0;
  const DWORD window_thread = window ? GetWindowThreadProcessId(window, &process_id) : 0;
  const bool maximized = window && window_thread == expected_thread && process_id == GetCurrentProcessId() && IsWindow(window) && IsZoomed(window) != FALSE;
  napi_value result;
  if (napi_get_boolean(env, maximized, &result) != napi_ok) return Throw(env, "NativeFailure", "The maximized state could not be returned.");
  return result;
}

napi_value MenuActive(napi_env env, napi_callback_info info) {
  void* callback_data = nullptr;
  if (napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &callback_data) != napi_ok) return Throw(env, "NativeFailure", "The window fixture state could not be read.");
  if (!callback_data) return Throw(env, "NativeFailure", "The window fixture environment is unavailable.");
  const DWORD process_id = GetCurrentProcessId();
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return Throw(env, "NativeFailure", "The current process thread list could not be read.");
  bool active = false;
  THREADENTRY32 entry{};
  entry.dwSize = sizeof(entry);
  if (Thread32First(snapshot, &entry)) {
    do {
      if (entry.th32OwnerProcessID == process_id) {
        GUITHREADINFO gui_info{};
        gui_info.cbSize = sizeof(gui_info);
        if (GetGUIThreadInfo(entry.th32ThreadID, &gui_info) && (gui_info.flags & (GUI_INMENUMODE | GUI_POPUPMENUMODE))) {
          active = true;
          break;
        }
      }
      entry.dwSize = sizeof(entry);
    } while (Thread32Next(snapshot, &entry));
  }
  CloseHandle(snapshot);
  napi_value result;
  if (napi_get_boolean(env, active, &result) != napi_ok) return Throw(env, "NativeFailure", "The menu state could not be returned.");
  return result;
}

napi_value CloseWindow(napi_env env, napi_callback_info info) {
  void* callback_data = nullptr;
  if (napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &callback_data) != napi_ok) return Throw(env, "NativeFailure", "The window fixture state could not be read.");
  auto* environment = static_cast<EnvironmentState*>(callback_data);
  if (!environment) return Throw(env, "NativeFailure", "The window fixture environment is unavailable.");
  std::shared_ptr<WindowState> state;
  {
    std::lock_guard<std::mutex> lock(environment->mutex);
    state = std::move(environment->window);
  }
  CloseWindowInternal(state);
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return Throw(env, "NativeFailure", "The fixture window was closed but the result could not be returned.");
  return result;
}

napi_value Initialize(napi_env env, napi_value exports) {
  auto environment = std::make_unique<EnvironmentState>();
  if (napi_add_env_cleanup_hook(env, FinalizeEnvironment, environment.get()) != napi_ok) return Throw(env, "NativeFailure", "The fixture environment could not be initialized.");
  EnvironmentState* callback_data = environment.get();
  environment.release();
  const struct { const char* name; napi_callback callback; } methods[] = {
    {"startWindow", StartWindow}, {"isMaximized", IsMaximized}, {"menuActive", MenuActive}, {"closeWindow", CloseWindow}
  };
  for (const auto& method : methods) {
    napi_value function;
    if (napi_create_function(env, method.name, NAPI_AUTO_LENGTH, method.callback, callback_data, &function) != napi_ok ||
        napi_set_named_property(env, exports, method.name, function) != napi_ok) return Throw(env, "NativeFailure", "The fixture methods could not be registered.");
  }
  return exports;
}
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)

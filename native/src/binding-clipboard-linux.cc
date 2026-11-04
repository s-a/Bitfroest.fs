#include "binding-clipboard-linux.h"
#include "clipboard-linux.h"
#include "clipboard-wayland-linux.h"
#include "linux-work.h"

#include <algorithm>
#include <cstring>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

namespace {
namespace Clipboard = native_linux_clipboard;
namespace Wayland = native_linux_wayland_clipboard;
bool WaylandContext() {
  const char* display = std::getenv("WAYLAND_DISPLAY");
  const char* socket = std::getenv("WAYLAND_SOCKET");
  return (display && *display) || (socket && *socket);
}
struct Job {
  std::shared_ptr<SessionState> state;
  std::shared_ptr<Clipboard::Session> clipboard;
  std::shared_ptr<Wayland::Session> wayland;
  Clipboard::Request request;
  Clipboard::Result result;
};
struct Closing {
  std::shared_ptr<Clipboard::Session> clipboard;
  std::shared_ptr<Wayland::Session> wayland;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  bool failed = false;
};

napi_value Fail(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message);
  return nullptr;
}
napi_value Text(napi_env env, const std::string& text) {
  napi_value result = nullptr;
  return napi_create_string_utf8(env, text.data(), text.size(), &result) == napi_ok ? result : nullptr;
}
bool Object(napi_env env, napi_value value) {
  napi_valuetype type;
  napi_value null_value = nullptr;
  bool array = true, null = true;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_object &&
      napi_is_array(env, value, &array) == napi_ok && !array &&
      napi_get_null(env, &null_value) == napi_ok &&
      napi_strict_equals(env, value, null_value, &null) == napi_ok && !null;
}
bool String(napi_env env, napi_value value, size_t maximum, std::string* output) {
  napi_valuetype type;
  size_t length = 0;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length > maximum) return false;
  std::vector<char> bytes(length + 1);
  if (napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &length) != napi_ok) return false;
  output->assign(bytes.data(), length);
  return output->find('\0') == std::string::npos;
}
bool Field(napi_env env, napi_value object, const char* key, size_t maximum, std::string* output) {
  napi_value value = nullptr;
  return napi_get_named_property(env, object, key, &value) == napi_ok && String(env, value, maximum, output);
}
bool SafePath(const std::string& path) {
  if (path.empty() || path.front() != '/') return false;
  size_t start = 1;
  for (;;) {
    const size_t end = path.find('/', start);
    if (path.substr(start, end == std::string::npos ? end : end - start) == "..") return false;
    if (end == std::string::npos) return true;
    start = end + 1;
  }
}
bool Paths(napi_env env, napi_value object, const char* key, bool empty, std::vector<std::string>* output) {
  napi_value value = nullptr;
  bool array = false;
  uint32_t count = 0;
  if (napi_get_named_property(env, object, key, &value) != napi_ok ||
      napi_is_array(env, value, &array) != napi_ok || !array ||
      napi_get_array_length(env, value, &count) != napi_ok || count > 1024 || (!empty && !count)) return false;
  size_t total = 0;
  for (uint32_t index = 0; index < count; ++index) {
    napi_value entry = nullptr;
    std::string path;
    if (napi_get_element(env, value, index, &entry) != napi_ok || !String(env, entry, 4096, &path) || !SafePath(path)) return false;
    total += path.size();
    if (total > 1048576 || std::find(output->begin(), output->end(), path) != output->end()) return false;
    output->push_back(std::move(path));
  }
  return true;
}
napi_value Array(napi_env env, const std::vector<std::string>& values) {
  napi_value result = nullptr;
  if (napi_create_array_with_length(env, values.size(), &result) != napi_ok) return nullptr;
  for (size_t index = 0; index < values.size(); ++index) {
    napi_value value = Text(env, values[index]);
    if (!value || napi_set_element(env, result, index, value) != napi_ok) return nullptr;
  }
  return result;
}
void Execute(void* data) {
  auto* job = static_cast<Job*>(data);
  if (job->state->closed.load()) {
    job->result.code = "SessionClosed";
    job->result.message = "The clipboard session is closed.";
    return;
  }
  job->result = job->wayland ? job->wayland->Invoke(job->request) : job->clipboard->Invoke(job->request);
}
LinuxWorkResult Complete(napi_env env, napi_status status, void* data) {
  auto* job = static_cast<Job*>(data);
  if (status != napi_ok || !job->result.ok || job->state->closed.load()) {
    const std::string code = job->state->closed.load() ? "SessionClosed" :
        !job->result.code.empty() ? job->result.code : !job->result.available ? "UnsupportedOperation" : "ClipboardFailure";
    napi_value error = nullptr, key = Text(env, code), message = Text(env,
        job->result.message.empty() ? "The Linux file clipboard request could not be completed." : job->result.message);
    if (!key || !message || napi_create_error(env, key, message, &error) != napi_ok) return {};
    return {error, true};
  }
  napi_value result = nullptr;
  if (napi_create_object(env, &result) != napi_ok) return {};
  if (job->request.operation == Clipboard::Operation::Read || job->request.operation == Clipboard::Operation::Write) {
    napi_value paths = Array(env, job->result.paths);
    napi_value mode = Text(env, job->result.mode == Clipboard::Mode::Move ? "move" : "copy");
    napi_value token = Text(env, job->result.token);
    if (!paths || !mode || !token || napi_set_named_property(env, result, "paths", paths) != napi_ok ||
        napi_set_named_property(env, result, "mode", mode) != napi_ok ||
        napi_set_named_property(env, result, "token", token) != napi_ok) return {};
  } else {
    napi_value matched = nullptr, errors = Array(env, job->result.notification_errors);
    if (!errors || napi_get_boolean(env, job->result.matched, &matched) != napi_ok ||
        napi_set_named_property(env, result, "matched", matched) != napi_ok ||
        napi_set_named_property(env, result, "notificationErrors", errors) != napi_ok) return {};
  }
  return {result, false};
}
void Destroy(void* data) { delete static_cast<Job*>(data); }
void Join(napi_env, void* data) {
  auto* closing = static_cast<Closing*>(data);
  try {
    if (closing->clipboard) closing->clipboard->AwaitStopped();
    if (closing->wayland) closing->wayland->AwaitStopped();
  } catch (...) { closing->failed = true; }
}
void Joined(napi_env env, napi_status status, void* data) {
  std::unique_ptr<Closing> closing(static_cast<Closing*>(data));
  if (env) {
    napi_value value = nullptr;
    if (status == napi_ok && !closing->failed && napi_get_undefined(env, &value) == napi_ok) napi_resolve_deferred(env, closing->deferred, value);
    else if (napi_create_error(env, Text(env, "ClipboardFailure"), Text(env, "The clipboard close barrier failed."), &value) == napi_ok) napi_reject_deferred(env, closing->deferred, value);
    if (closing->work) napi_delete_async_work(env, closing->work);
  }
}
}

bool IsLinuxClipboardOperation(const char* operation) {
  return std::strcmp(operation, "clipboard.readFiles") == 0 || std::strcmp(operation, "clipboard.writeFiles") == 0 ||
      std::strcmp(operation, "clipboard.acknowledge") == 0 || std::strcmp(operation, "clipboard.cancelFiles") == 0;
}
bool ProbeLinuxClipboard(std::string* reason) {
  return WaylandContext() ? Wayland::Probe(reason) : Clipboard::Probe(reason);
}
napi_value StartLinuxClipboardQuery(napi_env env, const std::shared_ptr<SessionState>& state,
                                    const char* operation, napi_value request) {
  if (!Object(env, request)) return Fail(env, "InvalidRequest", "A clipboard request object is required.");
  auto job = std::make_unique<Job>();
  job->state = state;
  auto& input = job->request;
  input.operation = std::strcmp(operation, "clipboard.readFiles") == 0 ? Clipboard::Operation::Read :
      std::strcmp(operation, "clipboard.writeFiles") == 0 ? Clipboard::Operation::Write :
      std::strcmp(operation, "clipboard.acknowledge") == 0 ? Clipboard::Operation::Acknowledge : Clipboard::Operation::Cancel;
  if (input.operation != Clipboard::Operation::Read) {
    std::string mode;
    if (!Field(env, request, "mode", 4, &mode) || (mode != "copy" && mode != "move") ||
        !Paths(env, request, "paths", false, &input.paths)) return Fail(env, "InvalidRequest", "A valid file selection and copy or move mode are required.");
    input.mode = mode == "move" ? Clipboard::Mode::Move : Clipboard::Mode::Copy;
    if (input.operation != Clipboard::Operation::Write &&
        (!Field(env, request, "token", 512, &input.token) || input.token.empty())) return Fail(env, "InvalidRequest", "A captured clipboard token is required.");
    if (input.operation == Clipboard::Operation::Acknowledge) {
      if (!Paths(env, request, "remainingPaths", true, &input.remaining_paths)) return Fail(env, "InvalidRequest", "A remaining selection is required.");
      for (const auto& path : input.remaining_paths) if (std::find(input.paths.begin(), input.paths.end(), path) == input.paths.end()) return Fail(env, "InvalidRequest", "The remaining selection is not part of the captured selection.");
    }
  }
  if (WaylandContext()) {
    if (!state->linux_wayland_clipboard_session) state->linux_wayland_clipboard_session = std::make_shared<Wayland::Session>();
    job->wayland = state->linux_wayland_clipboard_session;
  } else {
    if (!state->linux_clipboard_session) state->linux_clipboard_session = std::make_shared<Clipboard::Session>();
    job->clipboard = state->linux_clipboard_session;
  }
  return QueueLinuxWork(env, state, operation, job.release(), Execute, Complete, Destroy);
}
void CloseLinuxClipboardSession(const std::shared_ptr<SessionState>& state) {
  if (state->linux_clipboard_session) state->linux_clipboard_session->Shutdown();
  if (state->linux_wayland_clipboard_session) state->linux_wayland_clipboard_session->Shutdown();
}
napi_value WhenLinuxClipboardClosed(napi_env env, const std::shared_ptr<SessionState>& state) {
  auto closing = std::make_unique<Closing>();
  closing->clipboard = state->linux_clipboard_session;
  closing->wayland = state->linux_wayland_clipboard_session;
  napi_value promise = nullptr;
  if (napi_create_promise(env, &closing->deferred, &promise) != napi_ok) return nullptr;
  if (!closing->clipboard && !closing->wayland) {
    napi_value value = nullptr;
    if (napi_get_undefined(env, &value) == napi_ok) napi_resolve_deferred(env, closing->deferred, value);
    return promise;
  }
  if (closing->clipboard) closing->clipboard->Shutdown();
  if (closing->wayland) closing->wayland->Shutdown();
  if (napi_create_async_work(env, nullptr, Text(env, "clipboard.close"), Join, Joined, closing.get(), &closing->work) != napi_ok) return Fail(env, "BindingFailure", "Cannot create clipboard close work.");
  if (napi_queue_async_work(env, closing->work) != napi_ok) {
    napi_delete_async_work(env, closing->work);
    return Fail(env, "BindingFailure", "Cannot queue clipboard close work.");
  }
  closing.release();
  return promise;
}

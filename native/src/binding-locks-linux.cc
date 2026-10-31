#include "binding-locks-linux.h"

#include "locks-linux.h"
#include "linux-work.h"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <limits>
#include <memory>
#include <new>
#include <string>
#include <utility>
#include <vector>

namespace {
struct LinuxLockJob {
  std::shared_ptr<SessionState> session;
  std::string operation;
  std::string path;
  std::string destination;
  native_linux::FileIdentity expected_source{};
  native_linux::FileIdentity expected_parent{};
  bool has_expected_source = false;
  bool has_expected_parent = false;
  int64_t host_pid = 0;
  std::vector<native_linux::ProcessIdentity> processes;
  native_linux::ProcessResult process_result;
  native_linux::RenameResult rename_result;
  int native_error = 0;
  bool success = false;
};

napi_value MakeText(napi_env env, const std::string& text) {
  napi_value value = nullptr;
  if (napi_create_string_utf8(env, text.data(), text.size(), &value) != napi_ok) return nullptr;
  return value;
}

void Throw(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message);
}

bool ReadString(napi_env env, napi_value object, const char* name, std::string* output,
                bool required = true, size_t maximum = 32767) {
  napi_value value = nullptr;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok) return false;
  if (type == napi_undefined && !required) { output->clear(); return true; }
  if (type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length > maximum) return false;
  std::vector<char> buffer(length + 1, '\0');
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &written) != napi_ok || written != length ||
      std::find(buffer.begin(), buffer.begin() + static_cast<ptrdiff_t>(written), '\0') != buffer.begin() + static_cast<ptrdiff_t>(written)) return false;
  std::string result(buffer.data(), written);
  *output = std::move(result);
  return true;
}

bool ReadSafeInteger(napi_env env, napi_value value, int64_t* output) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok) return false;
  if (type == napi_number) {
    double number = 0;
    if (napi_get_value_double(env, value, &number) != napi_ok || !std::isfinite(number) ||
        std::trunc(number) != number || number < 0 || number > 9007199254740991.0) return false;
    *output = static_cast<int64_t>(number);
    return true;
  }
  if (type == napi_bigint) {
    uint64_t number = 0;
    bool lossless = false;
    if (napi_get_value_bigint_uint64(env, value, &number, &lossless) != napi_ok || !lossless ||
        number > static_cast<uint64_t>(std::numeric_limits<int64_t>::max())) return false;
    *output = static_cast<int64_t>(number);
    return true;
  }
  return false;
}

bool ReadIntegerProperty(napi_env env, napi_value object, const char* name, int64_t* output) {
  napi_value value = nullptr;
  return napi_get_named_property(env, object, name, &value) == napi_ok && ReadSafeInteger(env, value, output);
}

bool ReadIdentityPart(napi_env env, napi_value object, const char* name, uint64_t* output) {
  napi_value value = nullptr;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return false;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok) return false;
  if (type == napi_number) {
    double number = 0;
    if (napi_get_value_double(env, value, &number) != napi_ok || !std::isfinite(number) ||
        std::trunc(number) != number || number < 0 || number > 9007199254740991.0) return false;
    *output = static_cast<uint64_t>(number);
    return true;
  }
  if (type == napi_bigint) {
    bool lossless = false;
    return napi_get_value_bigint_uint64(env, value, output, &lossless) == napi_ok && lossless;
  }
  if (type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length == 0 || length > 20) return false;
  std::string text(length, '\0');
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, text.data(), text.size() + 1, &written) != napi_ok || written != length ||
      !std::all_of(text.begin(), text.end(), [](unsigned char ch) { return ch >= '0' && ch <= '9'; })) return false;
  uint64_t number = 0;
  const auto parsed = std::from_chars(text.data(), text.data() + text.size(), number, 10);
  if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size()) return false;
  *output = number;
  return true;
}

bool ReadIdentity(napi_env env, napi_value object, native_linux::FileIdentity* output) {
  napi_valuetype type;
  if (napi_typeof(env, object, &type) != napi_ok || type != napi_object) return false;
  return ReadIdentityPart(env, object, "dev", &output->device) && ReadIdentityPart(env, object, "ino", &output->inode);
}

bool IsAbsolutePath(const std::string& path) { return !path.empty() && path.front() == '/' && path.find('\0') == std::string::npos; }

bool IsInsidePath(const std::string& path, const std::string& root) {
  if (!IsAbsolutePath(path) || !IsAbsolutePath(root)) return false;
  const std::filesystem::path normalized_path = std::filesystem::path(path).lexically_normal();
  const std::filesystem::path normalized_root = std::filesystem::path(root).lexically_normal();
  auto path_part = normalized_path.begin();
  for (auto root_part = normalized_root.begin(); root_part != normalized_root.end(); ++root_part, ++path_part) {
    if (path_part == normalized_path.end() || *path_part != *root_part) return false;
  }
  return true;
}

bool ReadRows(napi_env env, napi_value request, const std::string& scope,
              std::vector<native_linux::ProcessIdentity>* rows) {
  napi_value array = nullptr;
  if (napi_get_named_property(env, request, "rows", &array) != napi_ok) return false;
  bool is_array = false;
  if (napi_is_array(env, array, &is_array) != napi_ok || !is_array) return false;
  uint32_t count = 0;
  if (napi_get_array_length(env, array, &count) != napi_ok) return false;
  rows->reserve(count);
  for (uint32_t index = 0; index < count; ++index) {
    napi_value item = nullptr;
    if (napi_get_element(env, array, index, &item) != napi_ok) return false;
    int64_t pid = 0;
    std::string started, file, kind;
    if (!ReadIntegerProperty(env, item, "pid", &pid) || pid <= 0 ||
        !ReadString(env, item, "started", &started, true, 512) || started.empty() ||
        !ReadString(env, item, "file", &file, true, 32767) || file.empty() ||
        !IsInsidePath(file, scope) || !ReadString(env, item, "kind", &kind, true, 32) ||
        (kind != "handle" && kind != "module" && kind != "image")) return false;
    rows->push_back({pid, std::move(started)});
  }
  return true;
}

bool ReadRequest(napi_env env, const char* operation, napi_value request, LinuxLockJob* job) {
  napi_valuetype type;
  if (!operation || napi_typeof(env, request, &type) != napi_ok || type != napi_object || type == napi_null) return false;
  bool is_array = false;
  if (napi_is_array(env, request, &is_array) != napi_ok || is_array) return false;
  job->operation = operation;
  if (job->operation == "locks.rename") {
    napi_value expected = nullptr, parent = nullptr;
    if (!ReadString(env, request, "path", &job->path) || !IsAbsolutePath(job->path) ||
        !ReadString(env, request, "destination", &job->destination) || !IsAbsolutePath(job->destination) ||
        napi_get_named_property(env, request, "expected", &expected) != napi_ok ||
        napi_get_named_property(env, request, "expectedParent", &parent) != napi_ok ||
        !ReadIdentity(env, expected, &job->expected_source) || !ReadIdentity(env, parent, &job->expected_parent)) return false;
    job->has_expected_source = true;
    job->has_expected_parent = true;
    return true;
  }
  if (job->operation == "processes.terminate") {
    if (!ReadString(env, request, "path", &job->path) || !IsAbsolutePath(job->path) ||
        !ReadIntegerProperty(env, request, "hostPid", &job->host_pid) || job->host_pid <= 0 ||
        !ReadRows(env, request, job->path, &job->processes)) return false;
    return true;
  }
  return false;
}

napi_value CreateOutcome(napi_env env, const char* status, uint32_t changed, uint32_t signalled) {
  napi_value outcome = nullptr, value = nullptr;
  if (napi_create_object(env, &outcome) != napi_ok ||
      !(value = MakeText(env, status)) || napi_set_named_property(env, outcome, "status", value) != napi_ok ||
      napi_create_uint32(env, changed, &value) != napi_ok || napi_set_named_property(env, outcome, "changed", value) != napi_ok ||
      napi_create_uint32(env, signalled, &value) != napi_ok || napi_set_named_property(env, outcome, "signalled", value) != napi_ok) return nullptr;
  return outcome;
}

napi_value CreateError(napi_env env, const LinuxLockJob& job, const char* code, const char* status) {
  napi_value message = MakeText(env, "The native lock operation failed.");
  napi_value error = nullptr;
  if (!message || napi_create_error(env, MakeText(env, code), message, &error) != napi_ok) return nullptr;
  napi_value operation = MakeText(env, job.operation);
  napi_value native_code = nullptr, changed = nullptr;
  const uint32_t changed_count = job.operation == "locks.rename" ? (job.rename_result.changed ? 1u : 0u) : job.process_result.changed;
  const uint32_t signalled_count = job.process_result.signalled;
  if (!operation || napi_create_int32(env, job.native_error, &native_code) != napi_ok ||
      napi_create_uint32(env, changed_count, &changed) != napi_ok ||
      napi_set_named_property(env, error, "operation", operation) != napi_ok ||
      napi_set_named_property(env, error, "nativeCode", native_code) != napi_ok ||
      napi_set_named_property(env, error, "changed", changed) != napi_ok) return nullptr;
  napi_value outcome = CreateOutcome(env, status, changed_count, signalled_count);
  if (!outcome || napi_set_named_property(env, error, "outcome", outcome) != napi_ok) return nullptr;
  return error;
}

napi_value CreateResult(napi_env env, const LinuxLockJob& job) {
  napi_value result = nullptr, rows = nullptr, errors = nullptr;
  const size_t error_count = job.operation == "processes.terminate" ? job.process_result.errors.size() : 0;
  if (napi_create_object(env, &result) != napi_ok || napi_create_array(env, &rows) != napi_ok ||
      napi_create_array_with_length(env, error_count, &errors) != napi_ok) return nullptr;
  for (size_t index = 0; index < error_count; ++index) {
    napi_value error = MakeText(env, job.process_result.errors[index]);
    if (!error || napi_set_element(env, errors, static_cast<uint32_t>(index), error) != napi_ok) return nullptr;
  }
  uint32_t changed = job.operation == "locks.rename" ? (job.rename_result.changed ? 1u : 0u) : job.process_result.changed;
  napi_value count = nullptr, zero = nullptr, empty = MakeText(env, "");
  if (!empty || napi_create_uint32(env, changed, &count) != napi_ok || napi_create_uint32(env, 0, &zero) != napi_ok ||
      napi_set_named_property(env, result, "rows", rows) != napi_ok ||
      napi_set_named_property(env, result, "inaccessible", zero) != napi_ok ||
      napi_set_named_property(env, result, "changed", count) != napi_ok ||
      napi_set_named_property(env, result, "errors", errors) != napi_ok ||
      napi_set_named_property(env, result, "backup", empty) != napi_ok ||
      napi_set_named_property(env, result, "token", empty) != napi_ok) return nullptr;
  const uint32_t signalled = job.process_result.signalled;
  const char* outcome_status = job.operation == "locks.rename"
      ? (job.rename_result.changed ? "committed" : "unchanged")
      : (signalled > changed ? "unknown"
         : (changed && error_count ? "partial" : (changed ? "committed" : "unchanged")));
  napi_value outcome = CreateOutcome(env, outcome_status, changed, signalled);
  if (!outcome || napi_set_named_property(env, result, "outcome", outcome) != napi_ok) return nullptr;
  return result;
}

void ExecuteLinuxLocks(void* data) {
  auto* job = static_cast<LinuxLockJob*>(data);
  try {
    if (job->operation == "locks.rename") {
      job->rename_result = native_linux::RenameExclusive(job->path, job->destination,
          job->has_expected_source ? &job->expected_source : nullptr,
          job->has_expected_parent ? &job->expected_parent : nullptr, &job->session->closed);
      job->native_error = job->rename_result.error_number;
      job->success = job->rename_result.changed;
    } else {
      job->process_result = native_linux::TerminateProcesses(job->processes, job->host_pid, &job->session->closed);
      job->success = !job->process_result.cancelled;
    }
  } catch (const std::bad_alloc&) {
    job->native_error = ENOMEM;
  } catch (...) {
    job->native_error = EIO;
  }
}

LinuxWorkResult CompleteLinuxLocks(napi_env env, napi_status status, void* data) {
  auto* job = static_cast<LinuxLockJob*>(data);
  const bool closed = job->session->closed.load();
  if (status != napi_ok && !job->native_error) job->native_error = status == napi_cancelled ? ECANCELED : EIO;

  if (!job->success || closed) {
    const bool cancelled = closed || job->native_error == ECANCELED || job->process_result.cancelled || job->rename_result.cancelled || status == napi_cancelled;
    const char* code = closed ? "SessionClosed" : (cancelled ? "Cancelled" : "NativeFailure");
    const uint32_t changed = job->operation == "locks.rename" ? (job->rename_result.changed ? 1u : 0u) : job->process_result.changed;
    const uint32_t signalled = job->process_result.signalled;
    const char* outcome = job->operation == "locks.rename"
        ? (job->rename_result.changed ? "committed" : "unchanged")
        : (cancelled ? (signalled > changed ? "unknown" : ((changed || signalled) ? "partial" : "unchanged"))
                     : (changed && !job->process_result.errors.empty() ? "partial" : (changed ? "committed" : "unchanged")));
    return {CreateError(env, *job, code, outcome), true};
  } else {
    return {CreateResult(env, *job), false};
  }

}

}  // namespace

bool IsLinuxLocksOperation(const char* operation) {
  return operation && (std::strcmp(operation, "locks.rename") == 0 || std::strcmp(operation, "processes.terminate") == 0);
}

napi_value StartLinuxLocks(napi_env env, const std::shared_ptr<SessionState>& state,
                           const char* operation, napi_value request) {
  if (!IsLinuxLocksOperation(operation)) {
    Throw(env, "UnsupportedOperation", "The Linux lock operation is unavailable.");
    return nullptr;
  }
  if (!state || state->closed.load()) {
    Throw(env, "SessionClosed", "The native session is closed.");
    return nullptr;
  }

  auto job = std::make_unique<LinuxLockJob>();
  job->session = state;
  if (!ReadRequest(env, operation, request, job.get())) {
    Throw(env, "InvalidRequest", "The native lock request is invalid.");
    return nullptr;
  }

  return QueueLinuxWork(env, state, operation, job.release(), ExecuteLinuxLocks, CompleteLinuxLocks,
      [](void* data) { delete static_cast<LinuxLockJob*>(data); });
}

napi_value WhenLinuxLocksClosed(napi_env env, const std::shared_ptr<SessionState>& state) {
  return WhenLinuxWorkClosed(env, state);
}

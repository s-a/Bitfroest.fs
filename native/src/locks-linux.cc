#include "locks-linux.h"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <limits>
#include <poll.h>
#include <signal.h>
#include <sstream>
#include <string_view>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <unordered_set>

namespace native_linux {
namespace {
#ifdef NATIVE_LOCKS_TESTING
TerminateSignalHookForTest terminate_signal_hook = nullptr;
void* terminate_signal_context = nullptr;
TerminatePollTimeoutHookForTest terminate_poll_timeout_hook = nullptr;
void* terminate_poll_timeout_context = nullptr;
#endif
class FileDescriptor final {
 public:
  explicit FileDescriptor(int value = -1) : value_(value) {}
  ~FileDescriptor() { if (value_ >= 0) close(value_); }
  FileDescriptor(const FileDescriptor&) = delete;
  FileDescriptor& operator=(const FileDescriptor&) = delete;
  int get() const { return value_; }
  explicit operator bool() const { return value_ >= 0; }
 private:
  int value_;
};

bool ReadFile(const std::string& path, std::string* value, int* error_number, size_t limit) {
  const int descriptor = open(path.c_str(), O_RDONLY | O_CLOEXEC);
  if (descriptor < 0) { if (error_number) *error_number = errno; return false; }
  FileDescriptor file(descriptor);
  value->clear();
  char buffer[512];
  for (;;) {
    const ssize_t count = read(file.get(), buffer, sizeof(buffer));
    if (count == 0) return true;
    if (count < 0) { if (errno == EINTR) continue; if (error_number) *error_number = errno; return false; }
    if (value->size() + static_cast<size_t>(count) > limit) { if (error_number) *error_number = EOVERFLOW; return false; }
    value->append(buffer, static_cast<size_t>(count));
  }
}

std::string ProcessStarted(int64_t pid, int* error_number) {
  std::string stat_line;
  if (!ReadFile("/proc/" + std::to_string(pid) + "/stat", &stat_line, error_number, 64 * 1024)) return {};
  const size_t close = stat_line.rfind(')');
  if (close == std::string::npos) { if (error_number) *error_number = EINVAL; return {}; }
  std::istringstream fields(stat_line.substr(close + 2));
  std::string token, start_time;
  for (int index = 0; index <= 19; ++index) {
    if (!(fields >> token)) { if (error_number) *error_number = EINVAL; return {}; }
    if (index == 19) start_time = token;
  }
  std::string boot_id;
  int ignored_error = 0;
  if (!ReadFile("/proc/sys/kernel/random/boot_id", &boot_id, &ignored_error, 256)) boot_id = "unknown";
  while (!boot_id.empty() && (boot_id.back() == '\n' || boot_id.back() == '\r')) boot_id.pop_back();
  if (boot_id.empty()) boot_id = "unknown";
  return "linux:" + boot_id + ":" + start_time;
}

bool ProcessOwner(int64_t pid, uid_t* owner, int* error_number) {
  struct stat value{};
  if (stat(("/proc/" + std::to_string(pid)).c_str(), &value) != 0) { if (error_number) *error_number = errno; return false; }
  *owner = value.st_uid;
  return true;
}

std::string ErrorText(int error_number) { return std::strerror(error_number); }
void AddProcessError(ProcessResult* result, int64_t pid, const std::string& message) {
  result->errors.push_back("PID " + std::to_string(pid) + ": " + message);
}
void AddErrno(ProcessResult* result, int64_t pid, int error_number) { AddProcessError(result, pid, ErrorText(error_number)); }

int OpenPidfd(pid_t pid) {
#if defined(SYS_pidfd_open)
  return static_cast<int>(syscall(SYS_pidfd_open, pid, 0));
#else
  (void)pid;
  errno = ENOSYS;
  return -1;
#endif
}

int PidfdSendSignal(int descriptor, int signal_number) {
#if defined(SYS_pidfd_send_signal)
  return static_cast<int>(syscall(SYS_pidfd_send_signal, descriptor, signal_number, nullptr, 0));
#else
  (void)descriptor;
  (void)signal_number;
  errno = ENOSYS;
  return -1;
#endif
}

bool RenameAtNoReplace(int source_parent, const char* source, int destination_parent, const char* destination) {
#if defined(SYS_renameat2) && defined(RENAME_NOREPLACE)
  return syscall(SYS_renameat2, source_parent, source, destination_parent, destination, RENAME_NOREPLACE) == 0;
#else
  (void)source_parent;
  (void)source;
  (void)destination_parent;
  (void)destination;
  errno = ENOSYS;
  return false;
#endif
}

bool SplitPath(const std::string& path, std::string* parent, std::string* name) {
  if (path.empty() || path.front() != '/' || path.find('\0') != std::string::npos || path.back() == '/') return false;
  const size_t separator = path.rfind('/');
  if (separator == std::string::npos) return false;
  *parent = separator == 0 ? "/" : path.substr(0, separator);
  *name = path.substr(separator + 1);
  return !name->empty() && *name != "." && *name != "..";
}

bool SameFileIdentity(const struct stat& value, const FileIdentity& expected) {
  return static_cast<uint64_t>(value.st_dev) == expected.device && static_cast<uint64_t>(value.st_ino) == expected.inode;
}
}

LockCapabilities ProbeCapabilities() {
  LockCapabilities result;
  const int descriptor = OpenPidfd(getpid());
  if (descriptor >= 0) {
    FileDescriptor pidfd(descriptor);
    result.terminate = PidfdSendSignal(pidfd.get(), 0) == 0;
  }
#if defined(SYS_renameat2) && defined(RENAME_NOREPLACE)
  errno = 0;
  const bool invalid_descriptor_result = RenameAtNoReplace(-1, "", -1, "");
  const int probe_error = errno;
  result.rename = invalid_descriptor_result || (probe_error != ENOSYS && probe_error != EINVAL);
#endif
  return result;
}

ProcessResult TerminateProcesses(const std::vector<ProcessIdentity>& rows, int64_t host_pid, const std::atomic<bool>* closed) {
  ProcessResult result;
  std::unordered_set<int64_t> seen;
  seen.reserve(rows.size());
  const int64_t self = getpid();
  const int64_t parent = getppid();
  for (const auto& row : rows) {
    if (closed && closed->load()) { result.cancelled = true; break; }
    if (!seen.insert(row.pid).second) continue;
    if (row.pid <= 1 || row.pid > std::numeric_limits<pid_t>::max() || row.pid == self || row.pid == parent || row.pid == host_pid) {
      AddProcessError(&result, row.pid, "Dieser Prozess darf hier nicht beendet werden.");
      continue;
    }
    const int descriptor = OpenPidfd(static_cast<pid_t>(row.pid));
    if (descriptor < 0) { AddErrno(&result, row.pid, errno); continue; }
    FileDescriptor pidfd(descriptor);

    int identity_error = 0;
    const std::string started = ProcessStarted(row.pid, &identity_error);
    uid_t owner = static_cast<uid_t>(-1);
    if (started.empty() || !ProcessOwner(row.pid, &owner, &identity_error)) {
      AddErrno(&result, row.pid, identity_error ? identity_error : EIO);
      continue;
    }
    if (started != row.started || owner != geteuid()) {
      AddProcessError(&result, row.pid, "Die Prozessidentität oder der Prozesseigentümer hat sich geändert.");
      continue;
    }
    if (closed && closed->load()) { result.cancelled = true; break; }
    if (PidfdSendSignal(pidfd.get(), SIGKILL) != 0) { AddErrno(&result, row.pid, errno); continue; }
    ++result.signalled;
#ifdef NATIVE_LOCKS_TESTING
    if (terminate_signal_hook) terminate_signal_hook(row.pid, terminate_signal_context);
#endif

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    bool exited = false;
    for (;;) {
      if (closed && closed->load()) { result.cancelled = true; break; }
      const auto now = std::chrono::steady_clock::now();
      if (now >= deadline) break;
      const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
      const int timeout = static_cast<int>(std::min<int64_t>(100, std::max<int64_t>(1, remaining.count())));
      pollfd item{pidfd.get(), POLLIN, 0};
      int ready = 0;
#ifdef NATIVE_LOCKS_TESTING
      if (terminate_poll_timeout_hook && terminate_poll_timeout_hook(terminate_poll_timeout_context)) ready = 0;
      else ready = poll(&item, 1, timeout);
#else
      ready = poll(&item, 1, timeout);
#endif
      if (ready > 0) { exited = (item.revents & (POLLIN | POLLHUP | POLLERR)) != 0; break; }
      if (ready < 0 && errno == EINTR) continue;
      if (ready < 0) { AddErrno(&result, row.pid, errno); break; }
      continue;
    }
    if (exited) {
      ++result.changed;
    }
    else if (!result.cancelled && (result.errors.empty() || result.errors.back().rfind("PID " + std::to_string(row.pid) + ": ", 0) != 0)) {
      AddProcessError(&result, row.pid, "Das Ende des Prozesses wurde noch nicht bestätigt.");
    }
    if (result.cancelled) break;
  }
  return result;
}

RenameResult RenameExclusive(const std::string& source, const std::string& destination,
                             const FileIdentity* expected_source,
                             const FileIdentity* expected_destination_parent,
                             const std::atomic<bool>* closed) {
  RenameResult result;
  if (closed && closed->load()) { result.cancelled = true; result.error_number = ECANCELED; result.error = ErrorText(ECANCELED); return result; }
  std::string source_directory, source_name, destination_directory, destination_name;
  if (!SplitPath(source, &source_directory, &source_name) || !SplitPath(destination, &destination_directory, &destination_name)) {
    result.error_number = EINVAL;
    result.error = "Absolute Pfade sind erforderlich.";
    return result;
  }
  FileDescriptor source_parent(open(source_directory.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  if (!source_parent) { result.error_number = errno; result.error = ErrorText(errno); return result; }
  FileDescriptor destination_parent(open(destination_directory.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  if (!destination_parent) { result.error_number = errno; result.error = ErrorText(errno); return result; }

  struct stat parent_stat{};
  if (fstat(destination_parent.get(), &parent_stat) != 0) { result.error_number = errno; result.error = ErrorText(errno); return result; }
  if (expected_destination_parent && !SameFileIdentity(parent_stat, *expected_destination_parent)) {
    result.error_number = ESTALE;
    result.error = "Der Zielordner hat sich geändert.";
    return result;
  }

  struct stat source_stat{};
  if (fstatat(source_parent.get(), source_name.c_str(), &source_stat, AT_SYMLINK_NOFOLLOW) != 0) { result.error_number = errno; result.error = ErrorText(errno); return result; }
  if (S_ISLNK(source_stat.st_mode) || (expected_source && !SameFileIdentity(source_stat, *expected_source))) {
    result.error_number = ESTALE;
    result.error = "Der Quellordner hat sich geändert.";
    return result;
  }
  if (closed && closed->load()) { result.cancelled = true; result.error_number = ECANCELED; result.error = ErrorText(ECANCELED); return result; }
  if (!RenameAtNoReplace(source_parent.get(), source_name.c_str(), destination_parent.get(), destination_name.c_str())) {
    result.error_number = errno;
    result.error = ErrorText(errno);
    return result;
  }
  result.changed = true;
  return result;
}

#ifdef NATIVE_LOCKS_TESTING
void SetTerminateSignalHookForTest(TerminateSignalHookForTest hook, void* context) {
  terminate_signal_hook = hook;
  terminate_signal_context = context;
}
void SetTerminatePollTimeoutHookForTest(TerminatePollTimeoutHookForTest hook, void* context) {
  terminate_poll_timeout_hook = hook;
  terminate_poll_timeout_context = context;
}
#endif

}  // namespace native_linux

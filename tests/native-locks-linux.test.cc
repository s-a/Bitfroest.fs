#include "../native/src/locks-linux.h"

#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <fstream>
#include <filesystem>
#include <grp.h>
#include <iostream>
#include <pwd.h>
#include <string>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <atomic>
#include <unistd.h>
#include <vector>

namespace {
int failures = 0;
void Check(bool condition, const char* label) {
  if (condition) return;
  std::cerr << "FAIL: " << label << '\n';
  ++failures;
}

class TempDirectory {
 public:
  TempDirectory() {
    char pattern[] = "/tmp/locks-linux-XXXXXX";
    char* result = mkdtemp(pattern);
    if (result) path_ = result;
  }
  ~TempDirectory() { if (!path_.empty()) { std::error_code error; std::filesystem::remove_all(path_, error); } }
  const std::string& path() const { return path_; }
 private:
  std::string path_;
};

bool Write(const std::string& path, const char* value) {
  std::ofstream stream(path, std::ios::binary);
  stream << value;
  return stream.good();
}
std::string Read(const std::string& path) {
  std::ifstream stream(path, std::ios::binary);
  return std::string(std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>());
}
native_linux::FileIdentity Identity(const std::string& path) {
  struct stat value{};
  if (lstat(path.c_str(), &value) != 0) return {};
  return {static_cast<uint64_t>(value.st_dev), static_cast<uint64_t>(value.st_ino)};
}
std::string Started(int64_t pid) {
  std::ifstream boot_stream("/proc/sys/kernel/random/boot_id");
  std::string boot;
  std::getline(boot_stream, boot);
  std::ifstream stat_stream("/proc/" + std::to_string(pid) + "/stat");
  std::string stat;
  std::getline(stat_stream, stat);
  const auto end = stat.rfind(')');
  if (end == std::string::npos) return {};
  std::string fields = stat.substr(end + 2);
  size_t cursor = 0;
  for (int index = 0; index < 19; ++index) {
    cursor = fields.find_first_not_of(' ', cursor);
    if (cursor == std::string::npos) return {};
    cursor = fields.find(' ', cursor);
    if (cursor == std::string::npos) return {};
  }
  cursor = fields.find_first_not_of(' ', cursor);
  const auto finish = fields.find(' ', cursor);
  if (cursor == std::string::npos) return {};
  return "linux:" + (boot.empty() ? "unknown" : boot) + ":" + fields.substr(cursor, finish - cursor);
}

pid_t Child() {
  int ready[2];
  if (pipe(ready) != 0) return -1;
  const pid_t pid = fork();
  if (pid == 0) {
    close(ready[0]);
    const char signal = 'R';
    if (write(ready[1], &signal, 1) != 1) _exit(2);
    close(ready[1]);
    for (;;) pause();
  }
  close(ready[1]);
  if (pid < 0) { close(ready[0]); return -1; }
  char signal = 0;
  const ssize_t count = read(ready[0], &signal, 1);
  close(ready[0]);
  return count == 1 && signal == 'R' ? pid : -1;
}
pid_t ChildWithCredentials(uid_t uid, gid_t gid) {
  int ready[2];
  if (pipe(ready) != 0) return -1;
  const pid_t pid = fork();
  if (pid == 0) {
    close(ready[0]);
    char state = 'R';
    if (setgid(gid) != 0 || setuid(uid) != 0 || geteuid() != uid) state = 'E';
    if (write(ready[1], &state, 1) != 1) _exit(2);
    close(ready[1]);
    if (state != 'R') _exit(3);
    for (;;) pause();
  }
  close(ready[1]);
  if (pid < 0) { close(ready[0]); return -1; }
  char state = 0;
  const ssize_t count = read(ready[0], &state, 1);
  close(ready[0]);
  if (count == 1 && state == 'R') return pid;
  (void)waitpid(pid, nullptr, 0);
  return -1;
}
struct ChildGuard {
  std::vector<pid_t> pids;
  ~ChildGuard() { for (pid_t pid : pids) if (pid > 1) { (void)kill(pid, SIGKILL); (void)waitpid(pid, nullptr, 0); } }
};

void TestCapabilities() {
  const auto capabilities = native_linux::ProbeCapabilities();
  Check(capabilities.terminate, "pidfd open and signal-zero probe reports termination support");
  Check(capabilities.rename, "renameat2 no-replace probe reports rename support");
}

void TestRename() {
  TempDirectory temp;
  Check(!temp.path().empty(), "temporary directory created");
  if (temp.path().empty()) return;
  const std::string source = temp.path() + "/source";
  const std::string destination = temp.path() + "/destination";
  const std::string free_destination = temp.path() + "/renamed";
  if (mkdir(source.c_str(), 0700) != 0 || mkdir(destination.c_str(), 0700) != 0) { Check(false, "fixture directories created"); return; }
  Check(Write(source + "/data", "source"), "source fixture written");
  Check(Write(destination + "/data", "destination"), "destination fixture written");
  auto existing = native_linux::RenameExclusive(source, destination, nullptr, nullptr);
  Check(!existing.changed && existing.error_number == EEXIST, "existing destination is preserved by atomic no-replace");
  Check(Read(source + "/data") == "source" && Read(destination + "/data") == "destination", "existing destination and source contents remain unchanged");

  const auto expected_source = Identity(source);
  auto wrong_source = expected_source; ++wrong_source.inode;
  auto source_mismatch = native_linux::RenameExclusive(source, free_destination, &wrong_source, nullptr);
  Check(!source_mismatch.changed && source_mismatch.error == "Der Quellordner hat sich geändert.", "changed source identity prevents rename");
  Check(access(source.c_str(), F_OK) == 0 && access(free_destination.c_str(), F_OK) != 0, "source mismatch causes no mutation");

  const auto expected_parent = Identity(temp.path());
  auto wrong_parent = expected_parent; ++wrong_parent.inode;
  auto parent_mismatch = native_linux::RenameExclusive(source, free_destination, &expected_source, &wrong_parent);
  Check(!parent_mismatch.changed && parent_mismatch.error == "Der Zielordner hat sich geändert.", "changed destination parent identity prevents rename");
  Check(access(source.c_str(), F_OK) == 0 && access(free_destination.c_str(), F_OK) != 0, "parent mismatch causes no mutation");

  std::atomic<bool> closed{true};
  auto cancelled = native_linux::RenameExclusive(source, free_destination, &expected_source, &expected_parent, &closed);
  Check(!cancelled.changed && cancelled.cancelled, "closed session prevents rename publication");
  Check(access(source.c_str(), F_OK) == 0 && access(free_destination.c_str(), F_OK) != 0, "closed rename leaves source and destination unchanged");

  auto renamed = native_linux::RenameExclusive(source, free_destination, &expected_source, &expected_parent);
  Check(renamed.changed && renamed.error_number == 0, "verified source renames into an absent destination");
  Check(access(source.c_str(), F_OK) != 0 && Read(free_destination + "/data") == "source", "successful rename preserves source directory contents");
  Check(!native_linux::RenameExclusive("relative", "/tmp/invalid", nullptr, nullptr).changed, "relative paths are rejected");
}

void CloseAfterFirstSignal(int64_t, void* context) {
  static_cast<std::atomic<bool>*>(context)->store(true);
}

bool ForceOnePidfdTimeout(void* context) {
  auto* forced = static_cast<bool*>(context);
  if (*forced) return false;
  *forced = true;
  return true;
}

void TestPidfdWaitAfterTimeout() {
  const pid_t child = Child();
  ChildGuard child_guard{{child}};
  Check(child > 1, "poll-timeout fixture child started");
  if (child <= 1) return;
  const native_linux::ProcessIdentity row{child, Started(child)};
  bool forced = false;
  native_linux::SetTerminatePollTimeoutHookForTest(ForceOnePidfdTimeout, &forced);
  const auto result = native_linux::TerminateProcesses({row}, getpid());
  native_linux::SetTerminatePollTimeoutHookForTest(nullptr, nullptr);
  Check(forced, "the first pidfd readiness check was forced to time out");
  Check(result.changed == 1 && result.signalled == 1 && result.errors.empty(),
        "termination waits again after a timeout and confirms the pidfd exit");
  int status = 0;
  const pid_t waited = waitpid(child, &status, 0);
  if (waited == child) child_guard.pids[0] = -1;
  Check(waited == child && WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL,
        "poll-timeout fixture is reaped after confirmed termination");
}

void TestCancellation() {
  {
    const pid_t first = Child(), second = Child();
    ChildGuard children{{first, second}};
    Check(first > 1 && second > 1, "two controlled child processes started");
    if (first <= 1 || second <= 1) return;
    const std::vector<native_linux::ProcessIdentity> rows{{first, Started(first)}, {second, Started(second)}};
    std::atomic<bool> closed{true};
    auto immediate = native_linux::TerminateProcesses(rows, getpid(), &closed);
    Check(immediate.cancelled && immediate.changed == 0, "already-closed session cancels before the first process");
    int first_status = 0, second_status = 0;
    const pid_t first_result = waitpid(first, &first_status, WNOHANG);
    const pid_t second_result = waitpid(second, &second_status, WNOHANG);
    Check(first_result == 0 && second_result == 0, "already-closed session leaves both child processes alive");
    if (first_result == first) children.pids[0] = -1;
    if (second_result == second) children.pids[1] = -1;
  }
  {
    const pid_t first = Child(), second = Child();
    ChildGuard children{{first, second}};
    Check(first > 1 && second > 1, "second controlled child pair started");
    if (first <= 1 || second <= 1) return;
    const std::vector<native_linux::ProcessIdentity> rows{{first, Started(first)}, {second, Started(second)}};
    std::atomic<bool> closed{false};
    const auto started = std::chrono::steady_clock::now();
    native_linux::SetTerminateSignalHookForTest(CloseAfterFirstSignal, &closed);
    auto after_first = native_linux::TerminateProcesses(rows, getpid(), &closed);
    native_linux::SetTerminateSignalHookForTest(nullptr, nullptr);
    const auto elapsed = std::chrono::steady_clock::now() - started;
    Check(after_first.cancelled && after_first.changed == 0, "close after the first signal cancels remaining rows");
    Check(after_first.signalled == 1, "close outcome records a process signal that was sent but not exit-confirmed");
    Check(elapsed < std::chrono::seconds(1), "close interrupts the pidfd wait promptly");
    int first_status = 0, second_status = 0;
    const pid_t first_result = waitpid(first, &first_status, 0);
    const pid_t second_result = waitpid(second, &second_status, WNOHANG);
    Check(first_result == first && WIFSIGNALED(first_status) && WTERMSIG(first_status) == SIGKILL,
          "first process mutation completes before cancellation");
    Check(second_result == 0, "process after cancellation boundary remains alive");
    if (first_result == first) children.pids[0] = -1;
    if (second_result == second) children.pids[1] = -1;
  }
}

void TestTerminate() {
  const pid_t child = Child();
  ChildGuard child_guard{{child}};
  Check(child > 1, "controlled child process started");
  if (child <= 1) return;
  native_linux::ProcessIdentity row{child, Started(child)};
  Check(!row.started.empty(), "child start identity read from procfs");
  auto stale = row; stale.started += ":stale";
  const auto rejected = native_linux::TerminateProcesses({stale}, getpid());
  Check(rejected.changed == 0 && rejected.errors.size() == 1, "stale process identity is rejected");
  Check(kill(child, 0) == 0, "stale identity does not signal the child");

  const auto denied = native_linux::TerminateProcesses({{getpid(), Started(getpid())}}, getpid());
  Check(denied.changed == 0 && denied.errors.size() == 1, "host process is never terminated");

  const auto terminated = native_linux::TerminateProcesses({row, row}, getpid());
  Check(terminated.changed == 1 && terminated.errors.empty(), "duplicate confirmed row terminates exactly once");
  int status = 0;
  const pid_t waited = waitpid(child, &status, 0);
  if (waited == child) child_guard.pids[0] = -1;
  Check(waited == child && WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL, "pidfd termination is confirmed by child exit");
}

void TestEffectiveUidGuard() {
  if (geteuid() != 0) {
    std::cout << "SKIP: Effective-UID safety case requires a root test process; current euid=" << geteuid() << '\n';
    return;
  }
  const passwd* account = getpwnam("nobody");
  if (!account || account->pw_uid == geteuid()) {
    std::cout << "SKIP: Effective-UID safety case requires an available non-root nobody account.\n";
    return;
  }
  const pid_t child = ChildWithCredentials(account->pw_uid, account->pw_gid);
  ChildGuard child_guard{{child}};
  if (child <= 1) {
    std::cout << "SKIP: The controlled child could not enter the nobody credentials.\n";
    return;
  }
  struct stat owner{};
  if (stat(("/proc/" + std::to_string(child)).c_str(), &owner) != 0 || owner.st_uid == geteuid()) {
    std::cout << "SKIP: Procfs does not expose the expected distinct child owner.\n";
    return;
  }
  const native_linux::ProcessIdentity row{child, Started(child)};
  Check(!row.started.empty(), "different-UID child start identity is available");
  const auto result = native_linux::TerminateProcesses({row}, getpid());
  Check(result.changed == 0 && result.errors.size() == 1,
        "root caller is denied pidfd termination of a child with another effective UID");
  Check(result.errors.size() == 1 && result.errors[0].find("Prozesseigentümer") != std::string::npos,
        "termination refusal identifies the owner mismatch");
  int status = 0;
  const pid_t alive = waitpid(child, &status, WNOHANG);
  Check(alive == 0, "different-UID child remains alive after the native termination request");
  if (kill(child, SIGKILL) != 0) Check(false, "test harness can stop its controlled different-UID child");
  const pid_t waited = waitpid(child, &status, 0);
  if (waited == child) child_guard.pids[0] = -1;
  Check(waited == child && WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL,
        "test harness reaps its controlled different-UID child");
}
}

int main(int argc, char** argv) {
  if (argc == 2 && std::string(argv[1]) == "uid-guard") {
    TestEffectiveUidGuard();
    return failures ? 1 : 0;
  }
  if (argc == 2 && std::string(argv[1]) == "pidfd-timeout") {
    TestPidfdWaitAfterTimeout();
    return failures ? 1 : 0;
  }
  if (argc == 2 && std::string(argv[1]) == "cancellation") {
    TestCancellation();
    return failures ? 1 : 0;
  }
  TestCapabilities();
  TestRename();
  TestTerminate();
  TestCancellation();
  return failures ? 1 : 0;
}

#pragma once

#include <cstdint>
#include <atomic>
#include <string>
#include <vector>

namespace native_linux {

struct LockCapabilities {
  bool terminate = false;
  bool rename = false;
};

struct ProcessIdentity {
  int64_t pid = 0;
  std::string started;
};

struct ProcessResult {
  uint32_t changed = 0;
  uint32_t signalled = 0;
  bool cancelled = false;
  std::vector<std::string> errors;
};

struct FileIdentity {
  uint64_t device = 0;
  uint64_t inode = 0;
};

struct RenameResult {
  bool changed = false;
  bool cancelled = false;
  int error_number = 0;
  std::string error;
};

LockCapabilities ProbeCapabilities();
ProcessResult TerminateProcesses(const std::vector<ProcessIdentity>& rows, int64_t host_pid,
                                 const std::atomic<bool>* closed = nullptr);
RenameResult RenameExclusive(const std::string& source, const std::string& destination,
                             const FileIdentity* expected_source,
                             const FileIdentity* expected_destination_parent,
                             const std::atomic<bool>* closed = nullptr);

#ifdef NATIVE_LOCKS_TESTING
using TerminateSignalHookForTest = void (*)(int64_t, void*);
void SetTerminateSignalHookForTest(TerminateSignalHookForTest hook, void* context);
using TerminatePollTimeoutHookForTest = bool (*)(void*);
void SetTerminatePollTimeoutHookForTest(TerminatePollTimeoutHookForTest hook, void* context);
#endif

}  // namespace native_linux

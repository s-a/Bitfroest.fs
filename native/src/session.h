#pragma once
#include <memory>
#include <atomic>

class FileTransferSession;
struct NativeLocksSessionState;
struct LinuxLocksSessionState;
struct GitIndexSessionState;

struct SessionState {
  std::atomic<bool> closed{false};
  std::shared_ptr<GitIndexSessionState> git_index_session;
  bool copy_busy = false;
  std::shared_ptr<FileTransferSession> copy_session;
  std::shared_ptr<NativeLocksSessionState> locks_session;
  std::shared_ptr<LinuxLocksSessionState> linux_locks_session;
};

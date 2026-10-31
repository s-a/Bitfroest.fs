#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

struct FileTransferIdentity {
  std::string dev;
  std::string ino;
  std::string size;
  std::string mtime_ns;
  std::string ctime_ns;
};

struct FileTransferOwnedDestination {
  FileTransferIdentity identity;
};

struct FileTransferRequest {
  std::wstring source;
  std::wstring target;
  std::vector<std::wstring> roots;
  FileTransferIdentity expected_source;
};

struct FileTransferProgress {
  uint64_t transferred = 0;
  uint64_t total = 0;
  std::optional<FileTransferOwnedDestination> owned_destination;
};

enum class FileTransferStatus {
  kCommitted,
  kUnchanged,
  kPartial,
  kUnknown
};

struct FileTransferResult {
  FileTransferStatus status = FileTransferStatus::kUnknown;
  bool cancelled = false;
  uint32_t native_error = 0;
  std::string code;
  std::string message;
  std::optional<FileTransferOwnedDestination> owned_destination;
};

class FileTransferSession {
 public:
  virtual ~FileTransferSession() = default;
  virtual bool Copy(const FileTransferRequest& request,
                    const std::function<bool()>& should_cancel,
                    const std::function<void(const FileTransferProgress&)>& on_progress,
                    FileTransferResult* result,
                    uint64_t request_ticket = 0) = 0;
  virtual void FinishCopy() = 0;
  virtual bool RegisterQueuedCopy() = 0;
  virtual void CancelQueuedCopy() = 0;
  virtual void RequestCancel() = 0;
  virtual void RequestIoCancel(uint64_t request_ticket) = 0;
  virtual void Shutdown() = 0;
  virtual void AwaitStopped() = 0;
};

std::shared_ptr<FileTransferSession> CreateNativeFileTransferSession();

void ExecuteNativeCopy(const FileTransferRequest& request,
                      const std::function<bool()>& should_cancel,
                      const std::function<void(const FileTransferProgress&)>& on_progress,
                      FileTransferResult* result);

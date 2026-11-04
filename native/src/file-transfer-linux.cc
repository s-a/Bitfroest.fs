#include "file-transfer-win.h"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <codecvt>
#include <condition_variable>
#include <cstring>
#include <fcntl.h>
#include <locale>
#include <mutex>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <utility>
#include <vector>

namespace {
class Descriptor final {
 public:
  explicit Descriptor(int value = -1) : value_(value) {}
  ~Descriptor() { if (value_ >= 0) close(value_); }
  Descriptor(const Descriptor&) = delete;
  Descriptor& operator=(const Descriptor&) = delete;
  Descriptor(Descriptor&& other) noexcept : value_(other.value_) { other.value_ = -1; }
  Descriptor& operator=(Descriptor&& other) noexcept {
    if (this != &other) { if (value_ >= 0) close(value_); value_ = other.value_; other.value_ = -1; }
    return *this;
  }
  int get() const { return value_; }
  explicit operator bool() const { return value_ >= 0; }
 private:
  int value_;
};

std::string Utf8(const std::wstring& value) {
  try { return std::wstring_convert<std::codecvt_utf8<wchar_t>>{}.to_bytes(value); }
  catch (...) { return {}; }
}

bool AbsoluteClean(const std::string& value) {
  if (value.empty() || value.front() != '/' || value.find('\0') != std::string::npos) return false;
  size_t start = 1;
  while (start <= value.size()) {
    const size_t end = value.find('/', start);
    const std::string part = value.substr(start, end - start);
    if (part == "." || part == "..") return false;
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return value.size() == 1 || value.back() != '/';
}

bool Below(const std::string& path, const std::string& root) {
  return root == "/" ? path.size() > 1 && path.front() == '/' :
         path.size() > root.size() && path.compare(0, root.size(), root) == 0 && path[root.size()] == '/';
}

bool Split(const std::string& path, std::string* parent, std::string* name) {
  const size_t slash = path.rfind('/');
  if (slash == std::string::npos || slash + 1 == path.size()) return false;
  *parent = slash == 0 ? "/" : path.substr(0, slash);
  *name = path.substr(slash + 1);
  return *name != "." && *name != "..";
}

Descriptor OpenDirectoryChain(const std::string& path) {
  Descriptor current(open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
  if (!current) return current;
  size_t start = 1;
  while (start < path.size()) {
    const size_t end = path.find('/', start);
    const std::string part = path.substr(start, end == std::string::npos ? end : end - start);
    Descriptor next(openat(current.get(), part.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    if (!next) return next;
    current = std::move(next);
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return current;
}

std::string Number(uint64_t value) { return std::to_string(value); }
int64_t NanoTime(const struct timespec& value) {
  return static_cast<int64_t>(value.tv_sec) * 1000000000LL + static_cast<int64_t>(value.tv_nsec);
}
FileTransferIdentity Identity(const struct stat& value) {
  return {Number(static_cast<uint64_t>(value.st_dev)), Number(static_cast<uint64_t>(value.st_ino)),
          Number(static_cast<uint64_t>(value.st_size)), std::to_string(NanoTime(value.st_mtim)), std::to_string(NanoTime(value.st_ctim))};
}
bool SameIdentity(const struct stat& value, const FileTransferIdentity& expected) {
  const FileTransferIdentity actual = Identity(value);
  return actual.dev == expected.dev && actual.ino == expected.ino && actual.size == expected.size &&
         actual.mtime_ns == expected.mtime_ns && actual.ctime_ns == expected.ctime_ns;
}
bool SameIdentity(const FileTransferIdentity& left, const FileTransferIdentity& right) {
  return left.dev == right.dev && left.ino == right.ino && left.size == right.size &&
         left.mtime_ns == right.mtime_ns && left.ctime_ns == right.ctime_ns;
}
void SetUnchanged(FileTransferResult* result, const char* code, const char* message, int error, bool cancelled = false) {
  result->status = FileTransferStatus::kUnchanged;
  result->cancelled = cancelled;
  result->native_error = static_cast<uint32_t>(error);
  result->code = code;
  result->message = message;
}

void Copy(const FileTransferRequest& request, const std::function<bool()>& should_cancel,
          const std::function<void(const FileTransferProgress&)>& on_progress,
          const std::atomic<bool>& shutdown, FileTransferResult* result) {
  *result = FileTransferResult{};
  result->status = FileTransferStatus::kUnknown;
  const std::string source_path = Utf8(request.source), target_path = Utf8(request.target);
  if (!AbsoluteClean(source_path) || !AbsoluteClean(target_path) || source_path == target_path || request.roots.empty()) {
    SetUnchanged(result, "InvalidRequest", "Valid absolute Linux paths are required.", EINVAL); return;
  }
  std::vector<std::string> roots;
  for (const auto& wide : request.roots) {
    std::string root = Utf8(wide);
    if (!AbsoluteClean(root)) { SetUnchanged(result, "InvalidRequest", "An allowed root is invalid.", EINVAL); return; }
    roots.push_back(std::move(root));
  }
  const auto allowed = [&roots](const std::string& path) {
    return std::any_of(roots.begin(), roots.end(), [&path](const std::string& root) { return Below(path, root); });
  };
  if (!allowed(source_path) || !allowed(target_path)) {
    SetUnchanged(result, "OutsideRoots", "A copy path is outside the allowed roots.", EACCES); return;
  }
  if (shutdown.load() || (should_cancel && should_cancel())) {
    SetUnchanged(result, "Cancelled", "The copy was cancelled before it started.", ECANCELED, true); return;
  }

  std::string source_parent_path, source_name, target_parent_path, target_name;
  if (!Split(source_path, &source_parent_path, &source_name) || !Split(target_path, &target_parent_path, &target_name)) {
    SetUnchanged(result, "InvalidRequest", "A file path is required.", EINVAL); return;
  }
  Descriptor source_parent = OpenDirectoryChain(source_parent_path);
  Descriptor target_parent = OpenDirectoryChain(target_parent_path);
  if (!source_parent || !target_parent) {
    const int error = errno;
    SetUnchanged(result, "NativeFailure", "A source or destination directory could not be opened safely.", error); return;
  }
  struct stat parent_before{};
  if (fstat(target_parent.get(), &parent_before) != 0) {
    const int error = errno; SetUnchanged(result, "NativeFailure", "The destination directory could not be identified.", error); return;
  }
  Descriptor source(openat(source_parent.get(), source_name.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
  struct stat source_info{};
  if (!source || fstat(source.get(), &source_info) != 0 || !S_ISREG(source_info.st_mode)) {
    const int error = source ? (errno ? errno : EINVAL) : errno;
    SetUnchanged(result, "NativeFailure", "The source is not a readable regular file.", error); return;
  }
  const FileTransferIdentity observed = Identity(source_info);
  if (observed.dev != request.expected_source.dev || observed.ino != request.expected_source.ino ||
      observed.size != request.expected_source.size || observed.mtime_ns != request.expected_source.mtime_ns ||
      observed.ctime_ns != request.expected_source.ctime_ns) {
    SetUnchanged(result, "IdentityChanged", "The source changed before copying.", ESTALE);
    result->expected_source = request.expected_source;
    result->observed_source = observed;
    return;
  }
  Descriptor destination(openat(target_parent.get(), target_name.c_str(),
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, source_info.st_mode & 07777));
  if (!destination) {
    const int error = errno;
    SetUnchanged(result, error == EEXIST ? "AlreadyExists" : "NativeFailure",
                 error == EEXIST ? "The destination already exists." : "The destination could not be created exclusively.", error);
    return;
  }
  uint64_t transferred = 0;
  int failure = 0;
  char buffer[256 * 1024];
  while (transferred < static_cast<uint64_t>(source_info.st_size)) {
    if (shutdown.load() || (should_cancel && should_cancel())) { failure = ECANCELED; break; }
    const size_t remaining = static_cast<size_t>(static_cast<uint64_t>(source_info.st_size) - transferred);
    const ssize_t count = read(source.get(), buffer, std::min(sizeof(buffer), remaining));
    if (count < 0) { if (errno == EINTR) continue; failure = errno; break; }
    if (count == 0) { failure = EIO; break; }
    size_t written = 0;
    while (written < static_cast<size_t>(count)) {
      const ssize_t amount = write(destination.get(), buffer + written, static_cast<size_t>(count) - written);
      if (amount < 0) { if (errno == EINTR) continue; failure = errno; break; }
      if (amount == 0) { failure = EIO; break; }
      written += static_cast<size_t>(amount);
      transferred += static_cast<uint64_t>(amount);
      if (on_progress) {
        FileTransferProgress progress{transferred, static_cast<uint64_t>(source_info.st_size), std::nullopt};
        try { on_progress(progress); } catch (...) { failure = ECANCELED; break; }
      }
      if (shutdown.load() || (should_cancel && should_cancel())) { failure = ECANCELED; break; }
    }
    if (failure) break;
  }
  if (!failure) {
    struct stat source_after{};
    if (fstat(source.get(), &source_after) != 0) {
      failure = errno;
      result->expected_source = request.expected_source;
    } else if (!SameIdentity(source_after, request.expected_source)) {
      failure = ESTALE;
      result->expected_source = request.expected_source;
      result->observed_source = Identity(source_after);
    }
  }
  if (!failure && fchmod(destination.get(), source_info.st_mode & 07777) != 0) failure = errno;
  if (!failure) {
    const struct timespec times[2] = {source_info.st_atim, source_info.st_mtim};
    if (futimens(destination.get(), times) != 0) failure = errno;
  }
  if (!failure && fsync(destination.get()) != 0) failure = errno;
  struct stat final_identity{};
  struct stat visible_identity{};
  const bool held = fstat(destination.get(), &final_identity) == 0;
  const bool visible = fstatat(target_parent.get(), target_name.c_str(), &visible_identity, AT_SYMLINK_NOFOLLOW) == 0;
  struct stat parent_after{};
  Descriptor current_target_parent = OpenDirectoryChain(target_parent_path);
  struct stat current_parent_stat{};
  const bool same_parent = fstat(target_parent.get(), &parent_after) == 0 && current_target_parent &&
      fstat(current_target_parent.get(), &current_parent_stat) == 0 &&
      parent_before.st_dev == parent_after.st_dev && parent_before.st_ino == parent_after.st_ino &&
      parent_before.st_dev == current_parent_stat.st_dev && parent_before.st_ino == current_parent_stat.st_ino;
  const bool same_file = held && visible && same_parent && !S_ISLNK(visible_identity.st_mode) &&
      final_identity.st_dev == visible_identity.st_dev && final_identity.st_ino == visible_identity.st_ino;
  const bool same_signature = same_file && SameIdentity(Identity(final_identity), Identity(visible_identity));
  if (!failure && transferred == static_cast<uint64_t>(source_info.st_size)) {
    if (same_signature) {
      result->status = FileTransferStatus::kCommitted;
      result->code = "Committed";
      result->owned_destination = FileTransferOwnedDestination{Identity(final_identity)};
      return;
    }
    result->status = FileTransferStatus::kUnknown;
    result->code = "OutcomeUnknown";
    result->message = "The copied destination could not be matched to the operation handle.";
    return;
  }
  result->native_error = static_cast<uint32_t>(failure ? failure : EIO);
  result->cancelled = failure == ECANCELED || shutdown.load();
  result->code = result->cancelled ? "Cancelled" : "NativeFailure";
  result->message = result->cancelled ? "The copy was cancelled." : "The native copy did not finish.";
  if (same_signature) {
    result->status = FileTransferStatus::kPartial;
    result->owned_destination = FileTransferOwnedDestination{Identity(final_identity)};
    result->code = result->cancelled ? "CancelledWithPartial" : "NativeFailureWithPartial";
  } else if (!visible) {
    result->status = FileTransferStatus::kUnknown;
    result->code = "DestinationOwnershipUnknown";
  } else {
    result->status = FileTransferStatus::kUnknown;
    result->code = "DestinationOwnershipUnknown";
  }
}

class NativeFileTransferSession final : public FileTransferSession {
 public:
  bool Copy(const FileTransferRequest& request, const std::function<bool()>& should_cancel,
            const std::function<void(const FileTransferProgress&)>& on_progress, FileTransferResult* result,
            uint64_t request_ticket) override {
    if (!result) return false;
    { std::lock_guard<std::mutex> lock(mutex_); if (shutdown_.load() || active_) { SetUnchanged(result, "Busy", "The file transfer session is unavailable.", EBUSY); return false; } if (queued_) --queued_; active_ = true; io_active_ = true; active_ticket_ = request_ticket; cancel_.store(false); }
    const auto cancelled = [this, &should_cancel] {
      return cancel_.load() || (should_cancel && should_cancel());
    };
    try { ::Copy(request, cancelled, on_progress, shutdown_, result); }
    catch (...) { result->status = FileTransferStatus::kUnknown; result->code = "NativeFailure"; result->message = "The native copy failed unexpectedly."; }
    { std::lock_guard<std::mutex> lock(mutex_); if (active_ticket_ == request_ticket) io_active_ = false; }
    changed_.notify_all();
    return true;
  }
  void FinishCopy() override { { std::lock_guard<std::mutex> lock(mutex_); active_ = false; io_active_ = false; active_ticket_ = 0; } changed_.notify_all(); }
  bool RegisterQueuedCopy() override { std::lock_guard<std::mutex> lock(mutex_); if (shutdown_.load()) return false; ++queued_; return true; }
  void CancelQueuedCopy() override { { std::lock_guard<std::mutex> lock(mutex_); if (queued_) --queued_; } changed_.notify_all(); }
  void RequestCancel() override { cancel_.store(true); }
  void RequestIoCancel(uint64_t ticket) override { std::lock_guard<std::mutex> lock(mutex_); if (io_active_ && ticket && ticket == active_ticket_) cancel_.store(true); }
  void Shutdown() override { shutdown_.store(true); cancel_.store(true); }
  void AwaitStopped() override { std::unique_lock<std::mutex> lock(mutex_); changed_.wait(lock, [this] { return !active_ && queued_ == 0; }); }
 private:
  std::atomic<bool> shutdown_{false}, cancel_{false};
  std::mutex mutex_;
  std::condition_variable changed_;
  bool active_ = false;
  bool io_active_ = false;
  size_t queued_ = 0;
  uint64_t active_ticket_ = 0;
};
}

std::shared_ptr<FileTransferSession> CreateNativeFileTransferSession() {
  return std::make_shared<NativeFileTransferSession>();
}

void ExecuteNativeCopy(const FileTransferRequest& request, const std::function<bool()>& should_cancel,
                       const std::function<void(const FileTransferProgress&)>& on_progress, FileTransferResult* result) {
  auto session = CreateNativeFileTransferSession();
  if (session->Copy(request, should_cancel, on_progress, result)) session->FinishCopy();
  session->Shutdown();
  session->AwaitStopped();
}

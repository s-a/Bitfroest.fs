#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <fstream>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

#include "../native/src/file-transfer-linux.cc"

namespace {
std::wstring Wide(const std::string& value) { return std::wstring(value.begin(), value.end()); }
bool WriteFixture(const std::string& path, size_t bytes) {
  std::ofstream stream(path, std::ios::binary | std::ios::trunc);
  std::string chunk(4096, 'x');
  while (bytes) {
    const size_t count = bytes < chunk.size() ? bytes : chunk.size();
    stream.write(chunk.data(), static_cast<std::streamsize>(count));
    if (!stream) return false;
    bytes -= count;
  }
  return true;
}
FileTransferRequest Request(const std::string& root, const std::string& source, const std::string& target) {
  FileTransferRequest request;
  request.roots = {Wide(root)};
  request.source = Wide(source);
  request.target = Wide(target);
  struct stat value{};
  if (stat(source.c_str(), &value) == 0) {
    request.expected_source = {std::to_string(static_cast<uint64_t>(value.st_dev)),
      std::to_string(static_cast<uint64_t>(value.st_ino)), std::to_string(static_cast<uint64_t>(value.st_size)),
      std::to_string(static_cast<int64_t>(value.st_mtim.tv_sec) * 1000000000LL + value.st_mtim.tv_nsec),
      std::to_string(static_cast<int64_t>(value.st_ctim.tv_sec) * 1000000000LL + value.st_ctim.tv_nsec)};
  }
  return request;
}
}

int main() {
  char directory[] = "/tmp/native-copy-linux-XXXXXX";
  char* created = mkdtemp(directory);
  if (!created) return 1;
  const std::string root(created), stage = root + "/stage";
  if (mkdir(stage.c_str(), 0700) != 0) return 2;
  const std::string source = root + "/source", committed = stage + "/committed", partial = stage + "/partial";
  if (!WriteFixture(source, 2 * 1024 * 1024)) return 3;
  chmod(source.c_str(), 0640);
  const timespec source_times[2] = {{0, 0}, {-315619200, 123456789}};
  if (utimensat(AT_FDCWD, source.c_str(), source_times, 0) != 0) return 8;

  FileTransferResult copied;
  ExecuteNativeCopy(Request(root, source, committed), [] { return false; }, [&](const FileTransferProgress& value) {
    if (!value.total || value.transferred > value.total) std::abort();
  }, &copied);
  struct stat source_stat{}, copied_stat{};
  if (copied.status != FileTransferStatus::kCommitted || !copied.owned_destination ||
      stat(source.c_str(), &source_stat) != 0 || stat(committed.c_str(), &copied_stat) != 0 ||
      source_stat.st_dev != copied_stat.st_dev || source_stat.st_ino == copied_stat.st_ino ||
      (source_stat.st_mode & 0777) != (copied_stat.st_mode & 0777) || source_stat.st_mtim.tv_sec != copied_stat.st_mtim.tv_sec ||
      source_stat.st_mtim.tv_nsec != copied_stat.st_mtim.tv_nsec) return 4;

  FileTransferResult collision;
  ExecuteNativeCopy(Request(root, source, committed), [] { return false; }, {}, &collision);
  if (collision.status != FileTransferStatus::kUnchanged || collision.code != "AlreadyExists") return 5;

  auto session = CreateNativeFileTransferSession();
  FileTransferResult cancelled;
  size_t progress_count = 0;
  const bool entered = session->Copy(Request(root, source, partial), [] { return false; }, [&](const FileTransferProgress& value) {
    if (value.transferred > 0 && value.transferred < value.total) {
      ++progress_count;
      session->RequestCancel();
    }
  }, &cancelled);
  if (entered) session->FinishCopy();
  if (cancelled.status != FileTransferStatus::kPartial || !cancelled.cancelled || !cancelled.owned_destination || !progress_count) return 6;
  struct stat partial_stat{};
  if (stat(partial.c_str(), &partial_stat) != 0 || partial_stat.st_ino != std::stoull(cancelled.owned_destination->identity.ino)) return 7;

  const std::string changed = stage + "/source-changed";
  FileTransferResult changed_result;
  uint64_t maximum_reported = 0;
  bool source_mutated = false;
  ExecuteNativeCopy(Request(root, source, changed), [] { return false; }, [&](const FileTransferProgress& value) {
    maximum_reported = std::max(maximum_reported, value.transferred);
    if (!source_mutated && value.transferred > 0 && value.transferred < value.total) {
      const int descriptor = open(source.c_str(), O_WRONLY | O_CLOEXEC);
      if (descriptor >= 0) { const char replacement = 'z'; source_mutated = pwrite(descriptor, &replacement, 1, 2 * 1024 * 1024 - 1) == 1; close(descriptor); }
    }
  }, &changed_result);
  if (!source_mutated || maximum_reported > 2 * 1024 * 1024 || changed_result.status != FileTransferStatus::kPartial ||
      !changed_result.owned_destination || !changed_result.expected_source || !changed_result.observed_source) return 9;

  unlink(committed.c_str()); unlink(partial.c_str()); unlink(changed.c_str()); unlink(source.c_str()); rmdir(stage.c_str()); rmdir(root.c_str());
  std::puts("linux native copy: commit, metadata, exclusive collision, byte progress, cancellation and source mutation passed");
  return 0;
}

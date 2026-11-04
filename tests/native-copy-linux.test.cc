#include <cstdio>
#include <cstdlib>
#include <dirent.h>
#include <filesystem>
#include <fcntl.h>
#include <fstream>
#include <iterator>
#include <string>
#include <system_error>
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
std::string ReadFile(const std::string& path) {
  std::ifstream stream(path, std::ios::binary);
  return std::string(std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>());
}
size_t OpenDescriptorCount() {
  DIR* directory = opendir("/proc/self/fd");
  if (!directory) return 0;
  size_t count = 0;
  while (const dirent* entry = readdir(directory)) {
    if (entry->d_name[0] >= '0' && entry->d_name[0] <= '9') ++count;
  }
  closedir(directory);
  return count;
}
struct RemoveTree {
  std::string path;
  ~RemoveTree() { std::error_code error; std::filesystem::remove_all(path, error); }
};
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
  RemoveTree cleanup{root};
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
  const std::string source_bytes = ReadFile(source);
  if (source_bytes.size() != 2 * 1024 * 1024) return 10;

  FileTransferResult collision;
  ExecuteNativeCopy(Request(root, source, committed), [] { return false; }, {}, &collision);
  if (collision.status != FileTransferStatus::kUnchanged || collision.code != "AlreadyExists") return 5;

  const std::string replaced_target = stage + "/replaced", parked_target = stage + "/parked-native";
  FileTransferResult replaced_result;
  bool destination_exchanged = false;
  ExecuteNativeCopy(Request(root, source, replaced_target), [] { return false; }, [&](const FileTransferProgress& value) {
    if (destination_exchanged || !value.transferred || value.transferred >= value.total) return;
    if (rename(replaced_target.c_str(), parked_target.c_str()) != 0) std::abort();
    const int foreign = open(replaced_target.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (foreign < 0 || write(foreign, "FOREIGN!", 8) != 8) std::abort();
    close(foreign);
    destination_exchanged = true;
  }, &replaced_result);
  if (!destination_exchanged || replaced_result.status != FileTransferStatus::kUnknown || replaced_result.owned_destination ||
      ReadFile(replaced_target) != "FOREIGN!" || ReadFile(parked_target) != source_bytes) return 11;

  const std::string parent = root + "/destination-parent", parked_parent = root + "/destination-parent-original";
  if (mkdir(parent.c_str(), 0700) != 0) return 12;
  const std::string moved_parent_target = parent + "/copy";
  FileTransferResult moved_parent_result;
  bool parent_exchanged = false;
  ExecuteNativeCopy(Request(root, source, moved_parent_target), [] { return false; }, [&](const FileTransferProgress& value) {
    if (parent_exchanged || !value.transferred || value.transferred >= value.total) return;
    if (rename(parent.c_str(), parked_parent.c_str()) != 0 || mkdir(parent.c_str(), 0700) != 0) std::abort();
    parent_exchanged = true;
  }, &moved_parent_result);
  if (!parent_exchanged || moved_parent_result.status != FileTransferStatus::kUnknown || moved_parent_result.owned_destination ||
      ReadFile(parked_parent + "/copy") != source_bytes || access(moved_parent_target.c_str(), F_OK) == 0) return 13;

  const size_t descriptors_before_failures = OpenDescriptorCount();
  for (size_t attempt = 0; attempt < 32; ++attempt) {
    FileTransferResult repeated_collision;
    ExecuteNativeCopy(Request(root, source, committed), [] { return false; }, {}, &repeated_collision);
    if (repeated_collision.status != FileTransferStatus::kUnchanged || repeated_collision.code != "AlreadyExists" ||
        OpenDescriptorCount() != descriptors_before_failures) return 14;
  }

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

  std::puts("linux native copy: commit, metadata, exclusive collision, path replacement, descriptor cleanup, byte progress, cancellation and source mutation passed");
  return 0;
}

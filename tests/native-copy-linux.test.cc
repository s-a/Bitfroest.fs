#include <cstdio>
#include <cstdlib>
#include <dirent.h>
#include <filesystem>
#include <fcntl.h>
#include <fstream>
#include <iterator>
#include <string>
#include <system_error>
#include <sys/types.h>
#include <sys/xattr.h>
#include <sys/stat.h>
#include <linux/posix_acl.h>
#include <linux/posix_acl_xattr.h>
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
  if (lstat(source.c_str(), &value) == 0) {
    request.expected_source = {std::to_string(static_cast<uint64_t>(value.st_dev)),
      std::to_string(static_cast<uint64_t>(value.st_ino)), std::to_string(static_cast<uint64_t>(value.st_size)),
      std::to_string(static_cast<int64_t>(value.st_mtim.tv_sec) * 1000000000LL + value.st_mtim.tv_nsec),
      std::to_string(static_cast<int64_t>(value.st_ctim.tv_sec) * 1000000000LL + value.st_ctim.tv_nsec)};
  }
  return request;
}

struct TestAcl {
  uint32_t version;
  posix_acl_xattr_entry entries[5];
};

bool SetTestAcl(const std::string& path, const char* attribute = "system.posix_acl_access") {
  const TestAcl acl{
    POSIX_ACL_XATTR_VERSION,
    {{ACL_USER_OBJ, 6, 0xffffffffU}, {ACL_USER, 4, 123456U}, {ACL_GROUP_OBJ, 4, 0xffffffffU},
     {ACL_MASK, 4, 0xffffffffU}, {ACL_OTHER, 0, 0xffffffffU}}
  };
  return setxattr(path.c_str(), attribute, &acl, sizeof(acl), 0) == 0;
}

FileTransferIdentity PathIdentity(const std::string& path) {
  struct stat value{};
  if (lstat(path.c_str(), &value) != 0) return {};
  return {std::to_string(static_cast<uint64_t>(value.st_dev)), std::to_string(static_cast<uint64_t>(value.st_ino)),
      std::to_string(static_cast<uint64_t>(value.st_size)),
      std::to_string(static_cast<int64_t>(value.st_mtim.tv_sec) * 1000000000LL + value.st_mtim.tv_nsec),
      std::to_string(static_cast<int64_t>(value.st_ctim.tv_sec) * 1000000000LL + value.st_ctim.tv_nsec)};
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

  const std::string source_directory = root + "/source-directory", target_directory = stage + "/existing-directory";
  if (mkdir(source_directory.c_str(), 0700) != 0 || mkdir(target_directory.c_str(), 0700) != 0) return 41;
  const std::string source_child = source_directory + "/child", target_child = target_directory + "/child";
  if (!WriteFixture(source_child, 1024) || !WriteFixture(target_child, 2048) ||
      chmod(source_directory.c_str(), 0750) != 0 || chmod(target_directory.c_str(), 0700) != 0) return 42;
  if (geteuid() == 0 && chown(source_directory.c_str(), 65534, 65534) != 0) return 43;
  const char directory_attribute[] = "source-directory-metadata";
  const char old_directory_attribute[] = "destination-old-metadata";
  if (setxattr(source_directory.c_str(), "user.native-copy-directory", directory_attribute, sizeof(directory_attribute), 0) != 0 ||
      setxattr(target_directory.c_str(), "user.native-copy-directory", old_directory_attribute, sizeof(old_directory_attribute), 0) != 0 ||
      !SetTestAcl(source_directory, "system.posix_acl_default")) return 44;
  const timespec directory_times[2] = {{946684800, 234567890}, {978307200, 345678901}};
  if (utimensat(AT_FDCWD, source_directory.c_str(), directory_times, 0) != 0) return 45;
  struct stat source_directory_stat{}, target_directory_stat{};
  if (lstat(source_directory.c_str(), &source_directory_stat) != 0 || lstat(target_directory.c_str(), &target_directory_stat) != 0) return 46;
  FileTransferRequest directory_request = Request(root, source_directory, target_directory);
  directory_request.metadata_only = true;
  directory_request.expected_target = PathIdentity(target_directory);
  FileTransferResult directory_metadata_result;
  ExecuteNativeCopy(directory_request, [] { return false; }, {}, &directory_metadata_result);
  struct stat directory_after{}, source_directory_after{};
  char copied_directory_attribute[64]{};
  TestAcl copied_default_acl{};
  const TestAcl expected_default_acl{
    POSIX_ACL_XATTR_VERSION,
    {{ACL_USER_OBJ, 6, 0xffffffffU}, {ACL_USER, 4, 123456U}, {ACL_GROUP_OBJ, 4, 0xffffffffU},
     {ACL_MASK, 4, 0xffffffffU}, {ACL_OTHER, 0, 0xffffffffU}}
  };
  if (directory_metadata_result.status != FileTransferStatus::kCommitted || !directory_metadata_result.owned_destination ||
      lstat(source_directory.c_str(), &source_directory_after) != 0 || lstat(target_directory.c_str(), &directory_after) != 0 ||
      directory_after.st_dev != target_directory_stat.st_dev || directory_after.st_ino != target_directory_stat.st_ino ||
      directory_after.st_uid != source_directory_stat.st_uid || directory_after.st_gid != source_directory_stat.st_gid ||
      (directory_after.st_mode & 07777) != (source_directory_stat.st_mode & 07777) ||
      directory_after.st_atim.tv_sec != source_directory_stat.st_atim.tv_sec ||
      directory_after.st_atim.tv_nsec != source_directory_stat.st_atim.tv_nsec ||
      directory_after.st_mtim.tv_sec != source_directory_stat.st_mtim.tv_sec ||
      directory_after.st_mtim.tv_nsec != source_directory_stat.st_mtim.tv_nsec ||
      getxattr(target_directory.c_str(), "user.native-copy-directory", copied_directory_attribute, sizeof(copied_directory_attribute)) != static_cast<ssize_t>(sizeof(directory_attribute)) ||
      std::memcmp(copied_directory_attribute, directory_attribute, sizeof(directory_attribute)) != 0 ||
      getxattr(target_directory.c_str(), "system.posix_acl_default", &copied_default_acl, sizeof(copied_default_acl)) != static_cast<ssize_t>(sizeof(copied_default_acl)) ||
      std::memcmp(&copied_default_acl, &expected_default_acl, sizeof(copied_default_acl)) != 0 ||
      ReadFile(source_child) != std::string(1024, 'x') || ReadFile(target_child) != std::string(2048, 'x')) return 47;

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

  const std::string metadata_source = root + "/metadata-source";
  const std::string metadata_target = stage + "/metadata-target";
  if (!WriteFixture(metadata_source, 64 * 1024) || chmod(metadata_source.c_str(), 0640) != 0) return 15;
  if (geteuid() == 0 && chown(metadata_source.c_str(), 65534, 65534) != 0) return 16;
  const char user_attribute[] = "source-user-xattr";
  if (setxattr(metadata_source.c_str(), "user.native-copy-test", user_attribute, sizeof(user_attribute), 0) != 0) return 17;
  if (!SetTestAcl(metadata_source)) return 18;
  TestAcl source_acl{};
  char source_attribute[64]{};
  const TestAcl expected_acl{
    POSIX_ACL_XATTR_VERSION,
    {{ACL_USER_OBJ, 6, 0xffffffffU}, {ACL_USER, 4, 123456U}, {ACL_GROUP_OBJ, 4, 0xffffffffU},
     {ACL_MASK, 4, 0xffffffffU}, {ACL_OTHER, 0, 0xffffffffU}}
  };
  if (getxattr(metadata_source.c_str(), "user.native-copy-test", source_attribute, sizeof(source_attribute)) != static_cast<ssize_t>(sizeof(user_attribute)) ||
      std::memcmp(source_attribute, user_attribute, sizeof(user_attribute)) != 0 ||
      getxattr(metadata_source.c_str(), "system.posix_acl_access", &source_acl, sizeof(source_acl)) != static_cast<ssize_t>(sizeof(source_acl)) ||
      std::memcmp(&source_acl, &expected_acl, sizeof(source_acl)) != 0) return 24;
  FileTransferResult metadata_result;
  ExecuteNativeCopy(Request(root, metadata_source, metadata_target), [] { return false; }, {}, &metadata_result);
  struct stat metadata_source_stat{}, metadata_target_stat{};
  char copied_attribute[64]{};
  TestAcl copied_acl{};
  if (metadata_result.status != FileTransferStatus::kCommitted ||
      stat(metadata_source.c_str(), &metadata_source_stat) != 0 || stat(metadata_target.c_str(), &metadata_target_stat) != 0 ||
      metadata_source_stat.st_uid != metadata_target_stat.st_uid || metadata_source_stat.st_gid != metadata_target_stat.st_gid ||
      (metadata_source_stat.st_mode & 07777) != (metadata_target_stat.st_mode & 07777) ||
      getxattr(metadata_target.c_str(), "user.native-copy-test", copied_attribute, sizeof(copied_attribute)) != static_cast<ssize_t>(sizeof(user_attribute)) ||
      std::memcmp(copied_attribute, user_attribute, sizeof(user_attribute)) != 0 ||
      getxattr(metadata_target.c_str(), "system.posix_acl_access", &copied_acl, sizeof(copied_acl)) != static_cast<ssize_t>(sizeof(copied_acl)) ||
      std::memcmp(&copied_acl, &expected_acl, sizeof(copied_acl)) != 0) return 19;

  const std::string sparse_source = root + "/sparse-source";
  const std::string sparse_target = stage + "/sparse-target";
  const int sparse_fd = open(sparse_source.c_str(), O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (sparse_fd < 0 || ftruncate(sparse_fd, 16 * 1024 * 1024) != 0 ||
      pwrite(sparse_fd, "first-data", 10, 0) != 10 || pwrite(sparse_fd, "last-data", 9, 15 * 1024 * 1024) != 9) return 20;
  struct stat sparse_source_stat{};
  if (fstat(sparse_fd, &sparse_source_stat) != 0) return 21;
  const off_t source_gap_data = lseek(sparse_fd, 1024 * 1024, SEEK_DATA);
  if (source_gap_data < 12 * 1024 * 1024) return 22;
  close(sparse_fd);
  FileTransferResult sparse_result;
  uint64_t sparse_progress_data_bytes = 0;
  bool sparse_progress_seen = false;
  ExecuteNativeCopy(Request(root, sparse_source, sparse_target), [] { return false; }, [&](const FileTransferProgress& progress) {
    if (progress.transferred != progress.logical_processed.value_or(UINT64_MAX) ||
        progress.total != static_cast<uint64_t>(sparse_source_stat.st_size) || progress.measurement_basis != "logical" ||
        !progress.data_bytes_written || *progress.data_bytes_written > progress.transferred) std::abort();
    sparse_progress_seen = true;
    sparse_progress_data_bytes = *progress.data_bytes_written;
  }, &sparse_result);
  const int sparse_target_fd = open(sparse_target.c_str(), O_RDONLY | O_CLOEXEC);
  struct stat sparse_target_stat{};
  char sparse_first[10]{}, sparse_last[9]{};
  if (sparse_result.status != FileTransferStatus::kCommitted || sparse_target_fd < 0 ||
      fstat(sparse_target_fd, &sparse_target_stat) != 0 || sparse_target_stat.st_size != sparse_source_stat.st_size ||
      lseek(sparse_target_fd, 1024 * 1024, SEEK_DATA) < 12 * 1024 * 1024 ||
      pread(sparse_target_fd, sparse_first, sizeof(sparse_first), 0) != static_cast<ssize_t>(sizeof(sparse_first)) ||
      pread(sparse_target_fd, sparse_last, sizeof(sparse_last), 15 * 1024 * 1024) != static_cast<ssize_t>(sizeof(sparse_last)) ||
      std::memcmp(sparse_first, "first-data", sizeof(sparse_first)) != 0 ||
      std::memcmp(sparse_last, "last-data", sizeof(sparse_last)) != 0) return 23;
  if (!sparse_progress_seen || sparse_progress_data_bytes == 0 || sparse_progress_data_bytes >= static_cast<uint64_t>(sparse_source_stat.st_size)) return 25;

  const std::string symlink_source = root + "/symlink-source";
  const std::string symlink_target = stage + "/symlink-target";
  const std::string link_text = "missing/relative-target";
  if (symlink(link_text.c_str(), symlink_source.c_str()) != 0) return 26;
  if (geteuid() == 0 && fchownat(AT_FDCWD, symlink_source.c_str(), 65534, 65534, AT_SYMLINK_NOFOLLOW) != 0) return 28;
  const timespec symlink_times[2] = {{946684800, 234567890}, {978307200, 345678901}};
  if (utimensat(AT_FDCWD, symlink_source.c_str(), symlink_times, AT_SYMLINK_NOFOLLOW) != 0) return 29;
  struct stat symlink_source_before{};
  if (lstat(symlink_source.c_str(), &symlink_source_before) != 0) return 30;
  FileTransferResult symlink_result;
  ExecuteNativeCopy(Request(root, symlink_source, symlink_target), [] { return false; }, {}, &symlink_result);
  struct stat symlink_source_stat{}, symlink_target_stat{};
  char copied_link_text[128]{};
  if (symlink_result.status != FileTransferStatus::kCommitted ||
      lstat(symlink_source.c_str(), &symlink_source_stat) != 0 || lstat(symlink_target.c_str(), &symlink_target_stat) != 0 ||
      !S_ISLNK(symlink_target_stat.st_mode) || symlink_source_stat.st_size != symlink_target_stat.st_size ||
      symlink_source_stat.st_uid != symlink_target_stat.st_uid || symlink_source_stat.st_gid != symlink_target_stat.st_gid ||
      symlink_target_stat.st_uid != symlink_source_before.st_uid || symlink_target_stat.st_gid != symlink_source_before.st_gid ||
      symlink_target_stat.st_atim.tv_sec != symlink_source_before.st_atim.tv_sec ||
      symlink_target_stat.st_atim.tv_nsec != symlink_source_before.st_atim.tv_nsec ||
      symlink_target_stat.st_mtim.tv_sec != symlink_source_before.st_mtim.tv_sec ||
      symlink_target_stat.st_mtim.tv_nsec != symlink_source_before.st_mtim.tv_nsec) return 27;
  const ssize_t copied_link_length = readlink(symlink_target.c_str(), copied_link_text, sizeof(copied_link_text));
  if (
      copied_link_length != static_cast<ssize_t>(link_text.size()) ||
      std::string(copied_link_text, static_cast<size_t>(copied_link_length)) != link_text) return 27;

  char external_directory[] = "/tmp/native-copy-linux-link-target-XXXXXX";
  char* external_created = mkdtemp(external_directory);
  if (!external_created) return 31;
  const std::string external_root(external_created), external_file = external_root + "/unchanged";
  RemoveTree external_cleanup{external_root};
  {
    std::ofstream stream(external_file, std::ios::binary);
    stream << "external-target-content";
    if (!stream) return 32;
  }
  const std::string external_link = root + "/external-link", external_copy = stage + "/external-link-copy";
  if (symlink(external_file.c_str(), external_link.c_str()) != 0) return 33;
  FileTransferResult external_link_result;
  ExecuteNativeCopy(Request(root, external_link, external_copy), [] { return false; }, {}, &external_link_result);
  struct stat external_copy_stat{};
  char external_link_text[512]{};
  const ssize_t external_link_length = readlink(external_copy.c_str(), external_link_text, sizeof(external_link_text));
  if (external_link_result.status != FileTransferStatus::kCommitted || lstat(external_copy.c_str(), &external_copy_stat) != 0 ||
      !S_ISLNK(external_copy_stat.st_mode) || external_link_length != static_cast<ssize_t>(external_file.size()) ||
      std::string(external_link_text, static_cast<size_t>(external_link_length)) != external_file ||
      ReadFile(external_file) != "external-target-content") return 34;

  const std::string exchange_source = root + "/exchange-source", parked_source = root + "/exchange-source-original";
  const std::string exchange_target = stage + "/exchange-target";
  if (symlink("original-link-text", exchange_source.c_str()) != 0) return 35;
  FileTransferResult exchange_result;
  bool source_exchanged = false;
  ExecuteNativeCopy(Request(root, exchange_source, exchange_target), [] { return false; }, [&](const FileTransferProgress& progress) {
    if (source_exchanged || !progress.logical_processed) return;
    if (rename(exchange_source.c_str(), parked_source.c_str()) != 0 || symlink("foreign-link-text", exchange_source.c_str()) != 0) std::abort();
    source_exchanged = true;
  }, &exchange_result);
  char exchange_target_text[128]{}, exchange_source_text[128]{}, parked_source_text[128]{};
  const ssize_t exchange_target_length = readlink(exchange_target.c_str(), exchange_target_text, sizeof(exchange_target_text));
  const ssize_t exchange_source_length = readlink(exchange_source.c_str(), exchange_source_text, sizeof(exchange_source_text));
  const ssize_t parked_source_length = readlink(parked_source.c_str(), parked_source_text, sizeof(parked_source_text));
  if (!source_exchanged || exchange_result.status != FileTransferStatus::kUnknown || exchange_result.owned_destination ||
      exchange_target_length != static_cast<ssize_t>(strlen("original-link-text")) ||
      std::string(exchange_target_text, static_cast<size_t>(exchange_target_length)) != "original-link-text" ||
      exchange_source_length != static_cast<ssize_t>(strlen("foreign-link-text")) ||
      std::string(exchange_source_text, static_cast<size_t>(exchange_source_length)) != "foreign-link-text" ||
      parked_source_length != static_cast<ssize_t>(strlen("original-link-text")) ||
      std::string(parked_source_text, static_cast<size_t>(parked_source_length)) != "original-link-text") return 36;

  const std::string pre_cancel_source = root + "/pre-cancel-link", pre_cancel_target = stage + "/pre-cancel-link-copy";
  if (symlink("pre-cancel-text", pre_cancel_source.c_str()) != 0) return 37;
  FileTransferResult pre_cancel_result;
  ExecuteNativeCopy(Request(root, pre_cancel_source, pre_cancel_target), [] { return true; }, {}, &pre_cancel_result);
  struct stat pre_cancel_target_stat{};
  if (pre_cancel_result.status != FileTransferStatus::kUnchanged || !pre_cancel_result.cancelled ||
      lstat(pre_cancel_target.c_str(), &pre_cancel_target_stat) == 0 || errno != ENOENT) return 38;

  const std::string post_cancel_source = root + "/post-cancel-link", post_cancel_target = stage + "/post-cancel-link-copy";
  if (symlink("post-cancel-text", post_cancel_source.c_str()) != 0) return 39;
  auto link_session = CreateNativeFileTransferSession();
  FileTransferResult post_cancel_result;
  bool post_cancel_callback = false;
  const bool link_entered = link_session->Copy(Request(root, post_cancel_source, post_cancel_target), [] { return false; },
      [&](const FileTransferProgress&) { post_cancel_callback = true; link_session->RequestCancel(); }, &post_cancel_result);
  if (link_entered) link_session->FinishCopy();
  link_session->Shutdown();
  link_session->AwaitStopped();
  struct stat post_cancel_target_stat{};
  if (!post_cancel_callback || post_cancel_result.status != FileTransferStatus::kCommitted || post_cancel_result.cancelled ||
      lstat(post_cancel_target.c_str(), &post_cancel_target_stat) != 0 || !S_ISLNK(post_cancel_target_stat.st_mode)) return 40;
  close(sparse_target_fd);

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

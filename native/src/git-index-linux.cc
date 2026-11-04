#include "git-index-linux.h"

#include "linux-work.h"
#include "session.h"

#include <git2.h>
#include <linux/if_alg.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <charconv>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <memory>
#include <stdexcept>
#include <string>
#include <system_error>
#include <utility>
#include <vector>

namespace {
struct Failure : std::runtime_error {
  std::string code;
  Failure(const char* value, const char* message) : std::runtime_error(message), code(value) {}
};

void Require(bool condition, const char* code, const char* message) {
  if (!condition) throw Failure(code, message);
}

void Git(int result, const char* code, const char* message) {
  Require(result >= 0, code, message);
}

struct Fd {
  int value = -1;
  explicit Fd(int fd = -1) : value(fd) {}
  ~Fd() { if (value >= 0) close(value); }
  Fd(const Fd&) = delete;
  Fd& operator=(const Fd&) = delete;
};

struct IndexJob {
  std::shared_ptr<SessionState> session;
  std::shared_ptr<std::atomic<unsigned>> control = std::make_shared<std::atomic<unsigned>>(0);
  std::string root, target, expected_head, expected_reference, expected_index, expected_dev, expected_ino;
  std::string error, code;
  bool committed = false;
  int native_error = 0;
};

bool ReadString(napi_env env, napi_value object, const char* name, std::string* output, size_t maximum = 32767, bool allow_empty = false) {
  napi_value value = nullptr;
  napi_valuetype type;
  if (napi_get_named_property(env, object, name, &value) != napi_ok || napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || (!allow_empty && length == 0) || length > maximum) return false;
  std::vector<char> buffer(length + 1);
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &written) != napi_ok || written != length ||
      std::find(buffer.begin(), buffer.begin() + static_cast<ptrdiff_t>(written), '\0') != buffer.begin() + static_cast<ptrdiff_t>(written)) return false;
  output->assign(buffer.data(), written);
  return true;
}

bool IsIdentity(const std::string& text) {
  return !text.empty() && text.size() <= 20 && std::all_of(text.begin(), text.end(), [](unsigned char ch) { return ch >= '0' && ch <= '9'; });
}

std::string Decimal(uint64_t value) { return std::to_string(value); }

void CheckCancelled(IndexJob* job) {
  Require(!job->session->closed.load() && job->control->load() != 1, "Cancelled", "The Git index action was cancelled before publication.");
}

int OpenDirectoryTree(const std::filesystem::path& path) {
  const auto normalized = path.lexically_normal();
  Require(normalized.is_absolute(), "UnsafePath", "Absolute Linux Git paths are required.");
  Fd current(open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
  Require(current.value >= 0, "FileAccessDenied", "The filesystem root could not be opened.");
  for (const auto& part : normalized.relative_path()) {
    if (part == "." || part.empty()) continue;
    Require(part != "..", "UnsafePath", "Relative traversal is not supported.");
    int next = openat(current.value, part.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    Require(next >= 0, errno == ELOOP ? "UnsafePath" : "FileAccessDenied", "A Git directory path could not be opened without following symbolic links.");
    close(current.value);
    current.value = next;
  }
  return std::exchange(current.value, -1);
}

int OpenRegularAt(int directory, const char* name, int flags) {
  const int fd = openat(directory, name, flags | O_CLOEXEC | O_NOFOLLOW);
  Require(fd >= 0, errno == ELOOP ? "UnsafePath" : "FileAccessDenied", "A regular Git file could not be opened.");
  Fd opened(fd);
  struct stat info{};
  Require(fstat(opened.value, &info) == 0 && S_ISREG(info.st_mode), "UnsafePath", "Only regular Git files are supported.");
  return std::exchange(opened.value, -1);
}

std::vector<unsigned char> ReadAll(int fd) {
  struct stat info{};
  Require(fstat(fd, &info) == 0 && S_ISREG(info.st_mode) && info.st_size >= 0 && static_cast<uint64_t>(info.st_size) <= SIZE_MAX,
      "IndexReadFailed", "The Git index is not a readable regular file.");
  std::vector<unsigned char> bytes(static_cast<size_t>(info.st_size));
  Require(lseek(fd, 0, SEEK_SET) == 0, "IndexReadFailed", "The Git index could not be rewound.");
  size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t count = read(fd, bytes.data() + offset, bytes.size() - offset);
    if (count < 0 && errno == EINTR) continue;
    Require(count > 0, "IndexReadFailed", "The Git index read was incomplete.");
    offset += static_cast<size_t>(count);
  }
  return bytes;
}

std::string Sha256(const std::vector<unsigned char>& bytes) {
  Fd socket_fd(socket(AF_ALG, SOCK_SEQPACKET | SOCK_CLOEXEC, 0));
  Require(socket_fd.value >= 0, "HashUnavailable", "The Linux kernel hash interface is unavailable.");
  sockaddr_alg algorithm{};
  algorithm.salg_family = AF_ALG;
  std::memcpy(algorithm.salg_type, "hash", 5);
  std::memcpy(algorithm.salg_name, "sha256", 7);
  Require(bind(socket_fd.value, reinterpret_cast<sockaddr*>(&algorithm), sizeof(algorithm)) == 0,
      errno == ENOENT || errno == EAFNOSUPPORT ? "HashUnavailable" : "HashFailed", "The Linux kernel SHA-256 implementation is unavailable.");
  Fd operation(accept4(socket_fd.value, nullptr, nullptr, SOCK_CLOEXEC));
  Require(operation.value >= 0, "HashUnavailable", "The Linux kernel hash operation could not be opened.");
  size_t offset = 0;
  while (offset < bytes.size()) {
    const size_t length = std::min<size_t>(bytes.size() - offset, 1024 * 1024);
    const int flags = offset + length < bytes.size() ? MSG_MORE : 0;
    const ssize_t count = send(operation.value, bytes.data() + offset, length, flags);
    if (count < 0 && errno == EINTR) continue;
    Require(count > 0, "HashFailed", "The Git index digest could not be computed.");
    offset += static_cast<size_t>(count);
  }
  if (bytes.empty()) Require(send(operation.value, "", 0, 0) == 0, "HashFailed", "The empty Git index digest could not be computed.");
  unsigned char digest[32]{};
  size_t read_total = 0;
  while (read_total < sizeof(digest)) {
    const ssize_t count = read(operation.value, digest + read_total, sizeof(digest) - read_total);
    if (count < 0 && errno == EINTR) continue;
    Require(count > 0, "HashFailed", "The Git index digest could not be read.");
    read_total += static_cast<size_t>(count);
  }
  static constexpr char digits[] = "0123456789abcdef";
  std::string result;
  result.reserve(64);
  for (const auto byte : digest) { result.push_back(digits[byte >> 4]); result.push_back(digits[byte & 15]); }
  return result;
}

std::string Head(git_repository* repository) {
  git_reference* raw = nullptr;
  const int result = git_repository_head(&raw, repository);
  std::unique_ptr<git_reference, decltype(&git_reference_free)> reference(raw, git_reference_free);
  if (result == GIT_EUNBORNBRANCH || result == GIT_ENOTFOUND) return {};
  Git(result, "HeadUnavailable", "The Git HEAD could not be read.");
  char output[GIT_OID_HEXSZ + 1]{};
  git_oid_tostr(output, sizeof(output), git_reference_target(reference.get()));
  return output;
}

uint32_t ReadBigEndian32(const std::vector<unsigned char>& bytes, size_t offset) {
  Require(offset <= bytes.size() && bytes.size() - offset >= 4, "UnsupportedIndex", "The Git index header is incomplete.");
  return static_cast<uint32_t>(bytes[offset]) << 24 | static_cast<uint32_t>(bytes[offset + 1]) << 16 |
      static_cast<uint32_t>(bytes[offset + 2]) << 8 | bytes[offset + 3];
}

bool HasUnsupportedIndexExtension(const std::vector<unsigned char>& bytes) {
  Require(bytes.size() >= 32 && std::memcmp(bytes.data(), "DIRC", 4) == 0,
      "UnsupportedIndex", "The Git index signature is invalid.");
  const uint32_t version = ReadBigEndian32(bytes, 4);
  const uint32_t count = ReadBigEndian32(bytes, 8);
  Require(version >= 2 && version <= 4, "UnsupportedIndex", "The Git index version is unsupported.");
  size_t offset = 12;
  std::string previous_path;
  for (uint32_t entry = 0; entry < count; ++entry) {
    const size_t start = offset;
    Require(offset <= bytes.size() && bytes.size() - offset >= 62 + 20, "UnsupportedIndex", "The Git index entry is incomplete.");
    const uint16_t flags = static_cast<uint16_t>(bytes[offset + 60]) << 8 | bytes[offset + 61];
    offset += 62;
    if (flags & 0x4000) offset += 2;
    Require(offset <= bytes.size() - 20, "UnsupportedIndex", "The Git index entry is incomplete.");
    size_t prefix = 0;
    if (version == 4) {
      unsigned char byte = 0;
      Require(offset < bytes.size() - 20, "UnsupportedIndex", "The compressed Git index path is incomplete.");
      byte = bytes[offset++];
      prefix = byte & 0x7f;
      while (byte & 0x80) {
        Require(offset < bytes.size() - 20 && prefix < SIZE_MAX / 128 - 1, "UnsupportedIndex", "The compressed Git index path is invalid.");
        byte = bytes[offset++];
        prefix = (prefix + 1) * 128 + (byte & 0x7f);
      }
      Require(prefix <= previous_path.size(), "UnsupportedIndex", "The compressed Git index path is invalid.");
    }
    const auto path_end = std::find(bytes.begin() + static_cast<ptrdiff_t>(offset), bytes.end() - 20, 0);
    Require(path_end != bytes.end() - 20, "UnsupportedIndex", "The Git index path is unterminated.");
    const size_t suffix_length = static_cast<size_t>(path_end - (bytes.begin() + static_cast<ptrdiff_t>(offset)));
    std::string current_path = version == 4 ? previous_path.substr(0, previous_path.size() - prefix) : std::string();
    current_path.append(reinterpret_cast<const char*>(bytes.data() + offset), suffix_length);
    offset += suffix_length + 1;
    if (version < 4) offset = start + ((offset - start + 7) & ~static_cast<size_t>(7));
    Require(offset <= bytes.size() - 20, "UnsupportedIndex", "The Git index entry padding is invalid.");
    previous_path = std::move(current_path);
  }
  const size_t extensions_end = bytes.size() - 20;
  while (offset < extensions_end) {
    Require(extensions_end - offset >= 8, "UnsupportedIndex", "The Git index extension header is incomplete.");
    const std::string signature(reinterpret_cast<const char*>(bytes.data() + offset), 4);
    const uint32_t length = ReadBigEndian32(bytes, offset + 4);
    offset += 8;
    Require(length <= extensions_end - offset, "UnsupportedIndex", "The Git index extension is incomplete.");
    if (signature == "link" || signature == "sdir") return true;
    offset += length;
  }
  return false;
}

std::vector<std::string> Components(const std::filesystem::path& relative) {
  std::vector<std::string> output;
  for (const auto& part : relative) {
    const auto text = part.u8string();
    Require(!text.empty() && text != "." && text != ".." && text.find('\0') == std::string::npos,
        "UnsafePath", "The selected Git path is invalid.");
    output.push_back(text);
  }
  return output;
}

int OpenTargetAt(int root_fd, const std::vector<std::string>& parts, IndexJob* job) {
  Require(!parts.empty(), "UnsafePath", "A file inside the repository is required.");
  Fd parent(dup(root_fd));
  Require(parent.value >= 0, "FileAccessDenied", "The repository directory could not be duplicated.");
  for (size_t i = 0; i + 1 < parts.size(); ++i) {
    int next = openat(parent.value, parts[i].c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    Require(next >= 0, errno == ELOOP ? "UnsafePath" : "FileAccessDenied", "The selected path contains an unsupported directory.");
    close(parent.value);
    parent.value = next;
  }
  const int file_fd = OpenRegularAt(parent.value, parts.back().c_str(), O_RDONLY);
  Fd file(file_fd);
  struct stat info{};
  Require(fstat(file.value, &info) == 0, "FileAccessDenied", "The selected file identity could not be read.");
  Require(Decimal(info.st_dev) == job->expected_dev && Decimal(info.st_ino) == job->expected_ino,
      "StaleFile", "The selected file identity has changed.");
  return std::exchange(file.value, -1);
}

struct IndexLock {
  int directory = -1;
  int fd = -1;
  dev_t device = 0;
  ino_t inode = 0;
  bool published = false;
  ~IndexLock() {
    if (fd >= 0) {
      struct stat own{}, named{};
      if (!published && fstat(fd, &own) == 0 && fstatat(directory, "index.lock", &named, AT_SYMLINK_NOFOLLOW) == 0 &&
          own.st_dev == named.st_dev && own.st_ino == named.st_ino) unlinkat(directory, "index.lock", 0);
      close(fd);
    }
    if (directory >= 0) close(directory);
  }
};

struct TemporaryIndex {
  int fd = -1;
  std::string path;
  ~TemporaryIndex() {
    if (fd >= 0) close(fd);
    if (!path.empty()) unlink(path.c_str());
    if (!path.empty()) unlink((path + ".lock").c_str());
  }
};

void WriteAll(int fd, const std::vector<unsigned char>& bytes) {
  Require(ftruncate(fd, 0) == 0 && lseek(fd, 0, SEEK_SET) == 0, "IndexWriteFailed", "The Git index lock could not be prepared.");
  size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t count = write(fd, bytes.data() + offset, bytes.size() - offset);
    if (count < 0 && errno == EINTR) continue;
    Require(count > 0, "IndexWriteFailed", "The Git index lock write was incomplete.");
    offset += static_cast<size_t>(count);
  }
  Require(fsync(fd) == 0, "IndexWriteFailed", "The new Git index could not be flushed.");
}

void Execute(void* data) {
  auto* job = static_cast<IndexJob*>(data);
  bool initialized = false;
  try {
    CheckCancelled(job);
    Git(git_libgit2_init(), "GitInitializationFailed", "The Git runtime could not be initialized.");
    initialized = true;
    const std::filesystem::path root = std::filesystem::u8path(job->root).lexically_normal();
    const std::filesystem::path target = std::filesystem::u8path(job->target).lexically_normal();
    Require(root.is_absolute() && target.is_absolute(), "UnsafePath", "Absolute Linux Git paths are required.");
    const auto relative = target.lexically_relative(root);
    Require(!relative.empty() && !relative.is_absolute(), "UnsafePath", "The selected file is outside the repository.");
    const auto parts = Components(relative);
    Require(parts.front() != ".git", "UnsafePath", "Git metadata cannot be selected as a worktree file.");
    Fd root_fd(OpenDirectoryTree(root));
    Fd local_file(OpenTargetAt(root_fd.value, parts, job));
    git_repository* raw_repository = nullptr;
    Git(git_repository_open_ext(&raw_repository, job->root.c_str(), GIT_REPOSITORY_OPEN_NO_SEARCH, nullptr),
        "RepositoryUnavailable", "The exact Git repository could not be opened.");
    std::unique_ptr<git_repository, decltype(&git_repository_free)> repository(raw_repository, git_repository_free);
    Require(!git_repository_is_bare(repository.get()) && git_repository_workdir(repository.get()),
        "RepositoryUnavailable", "A working-tree repository is required.");
    const auto actual_root = std::filesystem::u8path(git_repository_workdir(repository.get())).lexically_normal();
    Fd actual_root_fd(OpenDirectoryTree(actual_root));
    struct stat requested_root_info{}, actual_root_info{};
    Require(fstat(root_fd.value, &requested_root_info) == 0 && fstat(actual_root_fd.value, &actual_root_info) == 0 &&
        requested_root_info.st_dev == actual_root_info.st_dev && requested_root_info.st_ino == actual_root_info.st_ino,
        "RepositoryMismatch", "The repository root has changed.");
    const auto gitdir = std::filesystem::u8path(git_repository_path(repository.get())).lexically_normal();
    const auto gitdir_relative = gitdir.lexically_relative(root);
    Require(!gitdir_relative.empty() && !gitdir_relative.is_absolute() && gitdir_relative != ".." &&
        gitdir_relative.native().rfind("..", 0) != 0, "UnsupportedRepository", "Git directories outside the repository are unsupported.");
    Fd gitdir_fd(OpenDirectoryTree(gitdir));
    IndexLock lock;
    lock.directory = dup(gitdir_fd.value);
    Require(lock.directory >= 0, "IndexAccessDenied", "The Git directory could not be retained.");
    lock.fd = openat(lock.directory, "index.lock", O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
    Require(lock.fd >= 0, errno == EEXIST ? "IndexLocked" : "IndexAccessDenied", "The Git index lock could not be acquired.");
    struct stat lock_info{}, source_info{};
    Require(fstat(lock.fd, &lock_info) == 0 && S_ISREG(lock_info.st_mode), "UnsafePath", "The Git index lock is not a regular file.");
    lock.device = lock_info.st_dev;
    lock.inode = lock_info.st_ino;

    git_transaction* raw_transaction = nullptr;
    Git(git_transaction_new(&raw_transaction, repository.get()), "HeadLocked", "The Git reference locks could not be prepared.");
    std::unique_ptr<git_transaction, decltype(&git_transaction_free)> transaction(raw_transaction, git_transaction_free);
    Git(git_transaction_lock_ref(transaction.get(), "HEAD"), "HeadLocked", "The Git HEAD is locked by another operation.");
    git_reference* raw_symbolic = nullptr;
    Git(git_reference_lookup(&raw_symbolic, repository.get(), "HEAD"), "HeadUnavailable", "The Git HEAD could not be read.");
    std::unique_ptr<git_reference, decltype(&git_reference_free)> symbolic(raw_symbolic, git_reference_free);
    const std::string head_reference = git_reference_type(symbolic.get()) == GIT_REFERENCE_SYMBOLIC ? git_reference_symbolic_target(symbolic.get()) : "HEAD";
    Require(head_reference == job->expected_reference, "StaleHead", "The current Git branch has changed.");
    if (head_reference != "HEAD") {
      Git(git_transaction_lock_ref(transaction.get(), head_reference.c_str()), "HeadLocked", "The current Git branch is locked by another operation.");
      git_reference* raw_branch = nullptr;
      const int branch_result = git_reference_lookup(&raw_branch, repository.get(), head_reference.c_str());
      std::unique_ptr<git_reference, decltype(&git_reference_free)> branch(raw_branch, git_reference_free);
      Require(branch_result == GIT_ENOTFOUND || (branch_result == 0 && git_reference_type(branch.get()) == GIT_REFERENCE_DIRECT),
          "UnsupportedRepository", "Symbolic branch aliases are unsupported by Git index actions.");
    }
    Require(Head(repository.get()) == job->expected_head, "StaleHead", "The Git HEAD has changed.");
    Fd source(OpenRegularAt(gitdir_fd.value, "index", O_RDONLY));
    Require(fstat(source.value, &source_info) == 0, "IndexReadFailed", "The Git index identity could not be read.");
    const auto original = ReadAll(source.value);
    Require(Sha256(original) == job->expected_index, "StaleIndex", "The Git index has changed.");
    Require(!HasUnsupportedIndexExtension(original), "UnsupportedIndex", "Split and sparse indexes are not supported by this action.");

    char temporary_name[] = "/tmp/git-index-XXXXXX";
    TemporaryIndex temporary;
    temporary.fd = mkstemp(temporary_name);
    Require(temporary.fd >= 0, "TemporaryUnavailable", "A temporary Git index could not be created.");
    temporary.path = temporary_name;
    WriteAll(temporary.fd, original);
    git_index* raw_index = nullptr;
    Git(git_index_open(&raw_index, temporary.path.c_str()), "UnsupportedIndex", "The Git index format is unsupported or invalid.");
    std::unique_ptr<git_index, decltype(&git_index_free)> index(raw_index, git_index_free);
    git_index* raw_repository_index = nullptr;
    Git(git_repository_index(&raw_repository_index, repository.get()), "UnsupportedIndex", "The repository index capabilities could not be read.");
    std::unique_ptr<git_index, decltype(&git_index_free)> repository_index(raw_repository_index, git_index_free);
    Git(git_index_set_caps(index.get(), git_index_caps(repository_index.get())), "UnsupportedIndex", "The repository index capabilities are unsupported.");
    for (size_t i = 0; i < git_index_entrycount(index.get()); ++i)
      Require(!(git_index_get_byindex(index.get(), i)->flags_extended & GIT_INDEX_ENTRY_SKIP_WORKTREE), "UnsupportedIndex", "Sparse indexes are not supported by this action.");
    std::string scope;
    for (size_t i = 0; i < parts.size(); ++i) { if (i) scope.push_back('/'); scope += parts[i]; }
    Require(!git_index_get_bypath(index.get(), scope.c_str(), 1) && !git_index_get_bypath(index.get(), scope.c_str(), 2) &&
        !git_index_get_bypath(index.get(), scope.c_str(), 3), "ConflictedIndex", "The selected file has unresolved merge conflicts.");
    const git_index_entry* entry = git_index_get_bypath(index.get(), scope.c_str(), 0);
    Require(entry, "NotTracked", "The selected file is not in the Git index.");
    Require(entry->mode == GIT_FILEMODE_BLOB || entry->mode == GIT_FILEMODE_BLOB_EXECUTABLE,
        "UnsafePath", "Only regular indexed files are supported.");
    bool in_head = false;
    if (!job->expected_head.empty()) {
      git_object* raw_head = nullptr;
      Git(git_revparse_single(&raw_head, repository.get(), "HEAD^{tree}"), "HeadUnavailable", "The committed tree could not be read.");
      std::unique_ptr<git_object, decltype(&git_object_free)> head(raw_head, git_object_free);
      git_tree_entry* raw_entry = nullptr;
      const int result = git_tree_entry_bypath(&raw_entry, reinterpret_cast<git_tree*>(head.get()), scope.c_str());
      std::unique_ptr<git_tree_entry, decltype(&git_tree_entry_free)> head_entry(raw_entry, git_tree_entry_free);
      Require(result == 0 || result == GIT_ENOTFOUND, "HeadUnavailable", "The committed file could not be read.");
      in_head = result == 0 && git_oid_equal(&entry->id, git_tree_entry_id(head_entry.get())) &&
          entry->mode == static_cast<uint32_t>(git_tree_entry_filemode(head_entry.get()));
    }
    if (!in_head) {
      const char* filter = nullptr;
      Git(git_attr_get(&filter, repository.get(), GIT_ATTR_CHECK_FILE_THEN_INDEX, scope.c_str(), "filter"),
          "FilterUnavailable", "Git clean-filter attributes could not be read.");
      Require(!filter || git_attr_value(filter) != GIT_ATTR_VALUE_STRING,
          "UnsupportedFilter", "Configured external clean filters are not supported by this action.");
      git_oid local_oid{};
      Git(git_repository_hashfile(&local_oid, repository.get(), job->target.c_str(), GIT_OBJECT_BLOB, scope.c_str()),
          "FileReadFailed", "The selected file content could not be verified.");
      Require(git_oid_equal(&entry->id, &local_oid), "StagedChanges", "The staged file content is not retained in HEAD or the local file.");
    }
    CheckCancelled(job);
    Git(git_index_remove_bypath(index.get(), scope.c_str()), "IndexWriteFailed", "The selected index entry could not be removed.");
    Git(git_index_write(index.get()), "IndexWriteFailed", "The temporary Git index could not be serialized.");
    const int updated_fd = open(temporary.path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    Require(updated_fd >= 0, "TemporaryUnavailable", "The serialized Git index could not be read.");
    Fd updated_file(updated_fd);
    const auto updated = ReadAll(updated_file.value);
    WriteAll(lock.fd, updated);

    Require(Head(repository.get()) == job->expected_head, "StaleHead", "The Git HEAD changed before publication.");
    struct stat current_index{};
    Require(fstatat(gitdir_fd.value, "index", &current_index, AT_SYMLINK_NOFOLLOW) == 0 &&
        current_index.st_dev == source_info.st_dev && current_index.st_ino == source_info.st_ino &&
        Sha256(ReadAll(source.value)) == job->expected_index,
        "StaleIndex", "The Git index changed before publication.");
    struct stat local_info{};
    Require(fstat(local_file.value, &local_info) == 0 && Decimal(local_info.st_dev) == job->expected_dev &&
        Decimal(local_info.st_ino) == job->expected_ino, "StaleFile", "The selected file identity changed before publication.");
    Fd local_current(OpenTargetAt(root_fd.value, parts, job));
    struct stat current_lock{};
    Require(fstatat(lock.directory, "index.lock", &current_lock, AT_SYMLINK_NOFOLLOW) == 0 &&
        current_lock.st_dev == lock.device && current_lock.st_ino == lock.inode,
        "IndexLocked", "The Git index lock identity changed.");
    CheckCancelled(job);
    unsigned expected = 0;
    Require(job->control->compare_exchange_strong(expected, 2), "Cancelled", "The Git index action was cancelled before publication.");
    Require(renameat(lock.directory, "index.lock", lock.directory, "index") == 0,
        "IndexPublishFailed", "The new Git index could not be published atomically.");
    lock.published = true;
    job->committed = true;
    job->control->store(3);
    Require(fsync(lock.directory) == 0, "IndexPublishFailed", "The published Git index directory could not be flushed.");
  } catch (const Failure& error) { job->code = error.code; job->error = error.what(); }
    catch (const std::bad_alloc&) { job->code = "ResourceExhausted"; job->error = "The Git index action could not allocate resources."; }
    catch (...) { job->code = "GitIndexFailure"; job->error = "The Git index action failed."; }
  if (initialized) git_libgit2_shutdown();
}

LinuxWorkResult Complete(napi_env env, napi_status status, void* data) {
  auto* job = static_cast<IndexJob*>(data);
  napi_value result = nullptr, value = nullptr;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_string_utf8(env, job->committed ? "committed" : "unchanged", NAPI_AUTO_LENGTH, &value) != napi_ok ||
      napi_set_named_property(env, result, "status", value) != napi_ok) return {};
  if (status == napi_ok && job->error.empty()) {
    if (napi_get_boolean(env, true, &value) != napi_ok || napi_set_named_property(env, result, "removed", value) != napi_ok) return {};
    return {result, false};
  }
  napi_value code = nullptr, message = nullptr, error = nullptr;
  if (napi_create_string_utf8(env, job->code.empty() ? "Cancelled" : job->code.c_str(), NAPI_AUTO_LENGTH, &code) != napi_ok ||
      napi_create_string_utf8(env, job->error.empty() ? "The Git index action was cancelled." : job->error.c_str(), NAPI_AUTO_LENGTH, &message) != napi_ok ||
      napi_create_error(env, code, message, &error) != napi_ok ||
      napi_set_named_property(env, error, "outcome", result) != napi_ok ||
      napi_create_int32(env, job->native_error, &value) != napi_ok || napi_set_named_property(env, error, "nativeCode", value) != napi_ok) return {};
  return {error, true};
}

void Destroy(void* data) { delete static_cast<IndexJob*>(data); }
}

napi_value StartLinuxGitUntrack(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request) {
  auto job = std::make_unique<IndexJob>();
  job->session = state;
  if (!ReadString(env, request, "repositoryRoot", &job->root) || !ReadString(env, request, "target", &job->target) ||
      !ReadString(env, request, "expectedHead", &job->expected_head, 64, true) ||
      !ReadString(env, request, "expectedReference", &job->expected_reference) ||
      !ReadString(env, request, "expectedIndex", &job->expected_index, 64) ||
      !ReadString(env, request, "expectedDev", &job->expected_dev, 20) || !IsIdentity(job->expected_dev) ||
      !ReadString(env, request, "expectedIno", &job->expected_ino, 20) || !IsIdentity(job->expected_ino) ||
      job->expected_index.size() != 64 || !std::all_of(job->expected_index.begin(), job->expected_index.end(), [](unsigned char ch) { return std::isxdigit(ch) != 0; })) {
    napi_throw_error(env, "InvalidRequest", "Git index actions require captured repository, file, HEAD and index identities.");
    return nullptr;
  }
  const auto control = job->control;
  return QueueLinuxWork(env, state, "git.untrack", job.release(), Execute, Complete, Destroy, control);
}

napi_value WhenLinuxGitIndexClosed(napi_env env, const std::shared_ptr<SessionState>& state) {
  return WhenLinuxWorkClosed(env, state);
}

bool ProbeLinuxGitIndex() {
  Fd socket_fd(socket(AF_ALG, SOCK_SEQPACKET | SOCK_CLOEXEC, 0));
  if (socket_fd.value < 0) return false;
  sockaddr_alg algorithm{};
  algorithm.salg_family = AF_ALG;
  std::memcpy(algorithm.salg_type, "hash", 5);
  std::memcpy(algorithm.salg_name, "sha256", 7);
  return bind(socket_fd.value, reinterpret_cast<sockaddr*>(&algorithm), sizeof(algorithm)) == 0;
}

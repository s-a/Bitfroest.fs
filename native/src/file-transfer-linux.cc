#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

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
#include <sys/xattr.h>
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

struct ExtendedAttribute {
  std::string name;
  std::vector<unsigned char> value;
};

bool ReadExtendedAttributes(int descriptor, std::vector<ExtendedAttribute>* attributes, int* error) {
  ssize_t name_bytes = flistxattr(descriptor, nullptr, 0);
  if (name_bytes < 0 && errno == ENOTSUP) return true;
  if (name_bytes < 0) { *error = errno; return false; }
  std::vector<char> names(static_cast<size_t>(name_bytes));
  if (name_bytes) {
    const ssize_t listed_bytes = flistxattr(descriptor, names.data(), names.size());
    if (listed_bytes != name_bytes) {
      *error = listed_bytes < 0 ? errno : EIO;
      return false;
    }
  }
  size_t cursor = 0;
  while (cursor < names.size()) {
    const size_t remaining = names.size() - cursor;
    const size_t length = strnlen(names.data() + cursor, remaining);
    if (!length || length == remaining) { *error = EIO; return false; }
    ExtendedAttribute attribute;
    attribute.name.assign(names.data() + cursor, length);
    ssize_t value_bytes = fgetxattr(descriptor, attribute.name.c_str(), nullptr, 0);
    if (value_bytes < 0) { *error = errno; return false; }
    attribute.value.resize(static_cast<size_t>(value_bytes));
    if (value_bytes) {
      const ssize_t read_bytes = fgetxattr(descriptor, attribute.name.c_str(), attribute.value.data(), attribute.value.size());
      if (read_bytes != value_bytes) {
        *error = read_bytes < 0 ? errno : EIO;
        return false;
      }
    }
    attributes->push_back(std::move(attribute));
    cursor += length + 1;
  }
  std::sort(attributes->begin(), attributes->end(), [](const auto& left, const auto& right) {
    const bool left_acl = left.name == "system.posix_acl_access" || left.name == "system.posix_acl_default";
    const bool right_acl = right.name == "system.posix_acl_access" || right.name == "system.posix_acl_default";
    if (left_acl != right_acl) return !left_acl;
    return left.name < right.name;
  });
  return true;
}

bool WriteAndVerifyExtendedAttributes(int descriptor, const std::vector<ExtendedAttribute>& attributes, int* error) {
  for (const auto& attribute : attributes) {
    const void* value = attribute.value.empty() ? nullptr : attribute.value.data();
    if (fsetxattr(descriptor, attribute.name.c_str(), value, attribute.value.size(), 0) != 0) {
      *error = errno;
      return false;
    }
    std::vector<unsigned char> copied(attribute.value.size());
    const ssize_t copied_bytes = fgetxattr(descriptor, attribute.name.c_str(),
        copied.empty() ? nullptr : copied.data(), copied.size());
    if (copied_bytes < 0) { *error = errno; return false; }
    if (static_cast<size_t>(copied_bytes) != attribute.value.size() || copied != attribute.value) {
      *error = EIO;
      return false;
    }
  }
  return true;
}

std::string ParentEntryPath(int parent, const std::string& name) {
  return "/proc/self/fd/" + std::to_string(parent) + "/" + name;
}

bool HasSymlinkExtendedAttributes(int parent, const std::string& name, bool* has_attributes, int* error) {
  const std::string anchored_path = ParentEntryPath(parent, name);
  const ssize_t bytes = llistxattr(anchored_path.c_str(), nullptr, 0);
  if (bytes < 0 && errno == ENOTSUP) { *has_attributes = false; return true; }
  if (bytes < 0) { *error = errno; return false; }
  *has_attributes = bytes != 0;
  return true;
}

bool SameDirectory(const std::string& path, int descriptor, const struct stat& before) {
  struct stat held_after{}, current{};
  Descriptor current_descriptor = OpenDirectoryChain(path);
  return fstat(descriptor, &held_after) == 0 && current_descriptor &&
      fstat(current_descriptor.get(), &current) == 0 && before.st_dev == held_after.st_dev &&
      before.st_ino == held_after.st_ino && before.st_dev == current.st_dev && before.st_ino == current.st_ino;
}

bool HasExtendedAttribute(const std::vector<ExtendedAttribute>& attributes, const char* name) {
  return std::any_of(attributes.begin(), attributes.end(), [name](const auto& attribute) { return attribute.name == name; });
}

void CopyDirectoryMetadata(const FileTransferRequest& request, const std::string& source_name,
                           const std::string& target_parent_path,
                           const std::string& target_name, int source_parent, int target_parent,
                           const struct stat& target_parent_before, const std::function<bool()>& should_cancel,
                           const std::atomic<bool>& shutdown, FileTransferResult* result) {
  if (!request.expected_target) {
    SetUnchanged(result, "InvalidRequest", "A full target directory identity is required for metadata-only copy.", EINVAL);
    return;
  }
  Descriptor source(openat(source_parent, source_name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  if (!source) {
    const int error = errno;
    SetUnchanged(result, "NativeFailure", "The source directory could not be opened safely.", error);
    return;
  }
  struct stat source_before{}, target_before{}, target_named{};
  if (fstat(source.get(), &source_before) != 0) {
    const int error = errno;
    SetUnchanged(result, "NativeFailure", "The source directory could not be identified.", error);
    return;
  }
  if (!S_ISDIR(source_before.st_mode)) {
    SetUnchanged(result, "NativeFailure", "The source is not a directory.", ENOTDIR);
    return;
  }
  if (!SameIdentity(source_before, request.expected_source)) {
    SetUnchanged(result, "IdentityChanged", "The source directory changed before metadata copy.", ESTALE);
    result->expected_source = request.expected_source;
    result->observed_source = Identity(source_before);
    return;
  }
  struct stat source_path_before{};
  if (fstatat(source_parent, source_name.c_str(), &source_path_before, AT_SYMLINK_NOFOLLOW) != 0 ||
      !SameIdentity(source_path_before, request.expected_source)) {
    SetUnchanged(result, "IdentityChanged", "The source directory path changed before metadata copy.", ESTALE);
    result->expected_source = request.expected_source;
    result->observed_source = Identity(source_path_before);
    return;
  }
  Descriptor target(openat(target_parent, target_name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  if (!target) {
    const int error = errno;
    SetUnchanged(result, "TargetIdentityChanged", "The destination directory could not be opened safely.", error);
    return;
  }
  if (fstat(target.get(), &target_before) != 0) {
    const int error = errno;
    SetUnchanged(result, "TargetIdentityChanged", "The destination directory could not be identified.", error);
    return;
  }
  if (!S_ISDIR(target_before.st_mode) || !SameIdentity(target_before, *request.expected_target)) {
    SetUnchanged(result, "TargetIdentityChanged", "The destination directory no longer matches its expected identity.", ESTALE);
    return;
  }
  if (fstatat(target_parent, target_name.c_str(), &target_named, AT_SYMLINK_NOFOLLOW) != 0) {
    const int error = errno;
    SetUnchanged(result, "TargetIdentityChanged", "The destination directory path could not be verified.", error);
    return;
  }
  if (!SameIdentity(target_named, *request.expected_target)) {
    SetUnchanged(result, "TargetIdentityChanged", "The destination directory no longer matches its expected identity.", ESTALE);
    return;
  }
  if (source_before.st_dev == target_before.st_dev && source_before.st_ino == target_before.st_ino) {
    SetUnchanged(result, "InvalidRequest", "The source and destination directories identify the same object.", EINVAL);
    return;
  }
  std::vector<ExtendedAttribute> attributes;
  int metadata_error = 0;
  if (!ReadExtendedAttributes(source.get(), &attributes, &metadata_error)) {
    SetUnchanged(result, "MetadataReadFailed", "Source directory extended attributes could not be read completely.", metadata_error);
    return;
  }
  struct stat source_after_read{};
  if (fstat(source.get(), &source_after_read) != 0 || !SameIdentity(source_after_read, request.expected_source)) {
    SetUnchanged(result, "IdentityChanged", "The source directory changed while its metadata was read.", ESTALE);
    result->expected_source = request.expected_source;
    result->observed_source = Identity(source_after_read);
    return;
  }
  if (shutdown.load() || (should_cancel && should_cancel())) {
    SetUnchanged(result, "Cancelled", "Directory metadata copy was cancelled before modification.", ECANCELED, true);
    return;
  }

  int failure = 0;
  const char* failure_message = "The source directory metadata could not be preserved.";
  struct stat current_target{};
  if (fstat(target.get(), &current_target) != 0) {
    failure = errno;
  } else if ((current_target.st_uid != source_before.st_uid || current_target.st_gid != source_before.st_gid) &&
             fchown(target.get(), source_before.st_uid, source_before.st_gid) != 0) {
    failure = errno;
    failure_message = "The source directory owner and group could not be preserved.";
  }
  if (!failure && (shutdown.load() || (should_cancel && should_cancel()))) failure = ECANCELED;
  if (!failure && !HasExtendedAttribute(attributes, "system.posix_acl_access") &&
      fremovexattr(target.get(), "system.posix_acl_access") != 0 && errno != ENODATA && errno != ENOTSUP) {
    failure = errno;
    failure_message = "The inherited destination access ACL could not be removed.";
  }
  if (!failure && !HasExtendedAttribute(attributes, "system.posix_acl_default") &&
      fremovexattr(target.get(), "system.posix_acl_default") != 0 && errno != ENODATA && errno != ENOTSUP) {
    failure = errno;
    failure_message = "The destination default ACL could not be removed.";
  }
  if (!failure && fchmod(target.get(), source_before.st_mode & 07777) != 0) {
    failure = errno;
    failure_message = "The source directory mode could not be preserved.";
  }
  if (!failure && !WriteAndVerifyExtendedAttributes(target.get(), attributes, &metadata_error)) {
    failure = metadata_error;
    failure_message = "A source directory extended attribute could not be preserved exactly.";
  }
  if (!failure && fstat(target.get(), &current_target) != 0) {
    failure = errno;
  } else if (!failure && (current_target.st_uid != source_before.st_uid || current_target.st_gid != source_before.st_gid ||
             (current_target.st_mode & 07777) != (source_before.st_mode & 07777))) {
    failure = EIO;
    failure_message = "The copied directory owner, group, or mode differs from the source.";
  }
  if (!failure) {
    const struct timespec times[2] = {source_before.st_atim, source_before.st_mtim};
    if (futimens(target.get(), times) != 0) {
      failure = errno;
      failure_message = "The source directory access and modification times could not be preserved.";
    }
  }
  if (!failure && fsync(target.get()) != 0) failure = errno;

  struct stat source_final{}, source_visible{}, target_final{}, target_visible{};
  const bool source_same = fstat(source.get(), &source_final) == 0 && SameIdentity(source_final, request.expected_source) &&
      fstatat(source_parent, source_name.c_str(), &source_visible, AT_SYMLINK_NOFOLLOW) == 0 &&
      SameIdentity(source_visible, request.expected_source);
  const bool target_held = fstat(target.get(), &target_final) == 0 && S_ISDIR(target_final.st_mode);
  const bool target_path_same = fstatat(target_parent, target_name.c_str(), &target_visible, AT_SYMLINK_NOFOLLOW) == 0 &&
      S_ISDIR(target_visible.st_mode) && target_final.st_dev == target_visible.st_dev && target_final.st_ino == target_visible.st_ino &&
      SameIdentity(Identity(target_final), Identity(target_visible));
  const bool parent_same = SameDirectory(target_parent_path, target_parent, target_parent_before);
  if (!source_same || !target_held || !target_path_same || !parent_same) {
    result->status = FileTransferStatus::kUnknown;
    result->code = "DestinationOwnershipUnknown";
    result->message = "The directory metadata result could not be bound to the expected source and destination identities.";
    result->expected_source = request.expected_source;
    if (!source_same) result->observed_source = Identity(source_final);
    return;
  }
  if (!failure) {
    result->status = FileTransferStatus::kCommitted;
    result->code = "Committed";
    result->owned_destination = FileTransferOwnedDestination{Identity(target_final)};
    return;
  }
  result->native_error = static_cast<uint32_t>(failure);
  result->cancelled = failure == ECANCELED || shutdown.load();
  const FileTransferIdentity final_identity = Identity(target_final);
  if (SameIdentity(target_before, *request.expected_target) && SameIdentity(final_identity, *request.expected_target)) {
    result->status = FileTransferStatus::kUnchanged;
    result->code = result->cancelled ? "Cancelled" : "MetadataFailure";
  } else {
    result->status = FileTransferStatus::kPartial;
    result->owned_destination = FileTransferOwnedDestination{final_identity};
    result->code = result->cancelled ? "CancelledWithPartial" : "MetadataFailure";
  }
  result->message = result->cancelled ? "Directory metadata copy was cancelled." : failure_message;
}

void CopySymlink(const FileTransferRequest& request, const std::string& source_name,
                 const std::string& target_parent_path,
                 const std::string& target_name, int source_parent, int target_parent,
                 const struct stat& target_parent_before, const std::function<bool()>& should_cancel,
                 const std::function<void(const FileTransferProgress&)>& on_progress,
                 const std::atomic<bool>& shutdown, FileTransferResult* result) {
  Descriptor source_link(openat(source_parent, source_name.c_str(), O_PATH | O_NOFOLLOW | O_CLOEXEC));
  struct stat source_info{};
  if (!source_link || fstat(source_link.get(), &source_info) != 0 || !S_ISLNK(source_info.st_mode)) {
    const int error = source_link ? (errno ? errno : EINVAL) : errno;
    SetUnchanged(result, "NativeFailure", "The symbolic link could not be opened safely.", error);
    return;
  }
  const FileTransferIdentity source_identity = Identity(source_info);
  if (!SameIdentity(source_info, request.expected_source)) {
    SetUnchanged(result, "IdentityChanged", "The source symbolic link changed before copying.", ESTALE);
    result->expected_source = request.expected_source;
    result->observed_source = source_identity;
    return;
  }

  bool has_link_attributes = false;
  int metadata_error = 0;
  if (!HasSymlinkExtendedAttributes(source_parent, source_name, &has_link_attributes, &metadata_error)) {
    SetUnchanged(result, "MetadataReadFailed", "The source symbolic-link attributes could not be inspected.", metadata_error);
    return;
  }
  struct stat source_named{};
  if (fstatat(source_parent, source_name.c_str(), &source_named, AT_SYMLINK_NOFOLLOW) != 0 ||
      !SameIdentity(source_named, request.expected_source)) {
    SetUnchanged(result, "IdentityChanged", "The source symbolic link changed during metadata inspection.", ESTALE);
    result->expected_source = request.expected_source;
    result->observed_source = Identity(source_named);
    return;
  }
  if (has_link_attributes) {
    SetUnchanged(result, "UnsupportedMetadata", "Symbolic-link extended attributes cannot be copied through a stable Linux file-descriptor API.", EOPNOTSUPP);
    return;
  }
  if (shutdown.load() || (should_cancel && should_cancel())) {
    SetUnchanged(result, "Cancelled", "The symbolic-link copy was cancelled before publication.", ECANCELED, true);
    return;
  }

  size_t capacity = source_info.st_size > 0 ? static_cast<size_t>(source_info.st_size) + 1 : 256;
  if (capacity < 256) capacity = 256;
  std::string link_text;
  for (; capacity <= 1024 * 1024; capacity *= 2) {
    std::vector<char> buffer(capacity);
    const ssize_t count = readlinkat(source_link.get(), "", buffer.data(), buffer.size());
    if (count < 0) {
      const int error = errno;
      SetUnchanged(result, "NativeFailure", "The source symbolic-link text could not be read from its held identity.", error);
      return;
    }
    if (static_cast<size_t>(count) < buffer.size()) {
      link_text.assign(buffer.data(), static_cast<size_t>(count));
      break;
    }
  }
  if (link_text.empty()) {
    SetUnchanged(result, "NativeFailure", "The source symbolic-link text is empty or exceeds the supported native limit.", ENAMETOOLONG);
    return;
  }
  struct stat source_after_read{};
  if (fstat(source_link.get(), &source_after_read) != 0 || !SameIdentity(source_after_read, request.expected_source)) {
    SetUnchanged(result, "IdentityChanged", "The source symbolic link changed while its text was read.", ESTALE);
    result->expected_source = request.expected_source;
    result->observed_source = Identity(source_after_read);
    return;
  }

  if (symlinkat(link_text.c_str(), target_parent, target_name.c_str()) != 0) {
    const int error = errno;
    SetUnchanged(result, error == EEXIST ? "AlreadyExists" : "NativeFailure",
        error == EEXIST ? "The destination already exists." : "The symbolic-link destination could not be created exclusively.", error);
    return;
  }
  Descriptor destination_link(openat(target_parent, target_name.c_str(), O_PATH | O_NOFOLLOW | O_CLOEXEC));
  struct stat destination_info{};
  if (!destination_link || fstat(destination_link.get(), &destination_info) != 0 || !S_ISLNK(destination_info.st_mode)) {
    result->status = FileTransferStatus::kUnknown;
    result->code = "DestinationOwnershipUnknown";
    result->message = "The created symbolic link could not be held by identity.";
    return;
  }

  int failure = 0;
  const char* failure_code = "MetadataFailure";
  const char* failure_message = "The source symbolic-link metadata could not be preserved.";
  if (destination_info.st_uid != source_info.st_uid || destination_info.st_gid != source_info.st_gid) {
    if (fchownat(destination_link.get(), "", source_info.st_uid, source_info.st_gid,
                 AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW) != 0) failure = errno;
  }
  if (!failure) {
    const struct timespec times[2] = {source_info.st_atim, source_info.st_mtim};
    if (utimensat(destination_link.get(), "", times, AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW) != 0) failure = errno;
  }
  struct stat source_final{}, destination_final{}, visible_final{};
  const bool source_held = fstat(source_link.get(), &source_final) == 0 && SameIdentity(source_final, request.expected_source);
  const bool source_visible = fstatat(source_parent, source_name.c_str(), &source_named, AT_SYMLINK_NOFOLLOW) == 0 &&
      SameIdentity(source_named, request.expected_source);
  const bool destination_held = fstat(destination_link.get(), &destination_final) == 0;
  const bool destination_visible = fstatat(target_parent, target_name.c_str(), &visible_final, AT_SYMLINK_NOFOLLOW) == 0 &&
      S_ISLNK(visible_final.st_mode);
  const bool parent_same = SameDirectory(target_parent_path, target_parent, target_parent_before);
  const bool destination_owned = source_held && source_visible && destination_held && destination_visible && parent_same &&
      destination_final.st_dev == visible_final.st_dev && destination_final.st_ino == visible_final.st_ino &&
      SameIdentity(Identity(destination_final), Identity(visible_final));
  if (!destination_owned) {
    result->status = FileTransferStatus::kUnknown;
    result->code = "DestinationOwnershipUnknown";
    result->message = "The symbolic-link destination could not be matched to the held operation identity.";
    result->expected_source = request.expected_source;
    if (!source_held || !source_visible) result->observed_source = Identity(source_final);
    return;
  }
  if (!failure && on_progress) {
    FileTransferProgress progress{static_cast<uint64_t>(link_text.size()), static_cast<uint64_t>(link_text.size()), std::nullopt,
        static_cast<uint64_t>(link_text.size()), static_cast<uint64_t>(link_text.size()), "logical"};
    try { on_progress(progress); }
    catch (...) { failure = ECANCELED; failure_code = "ProgressCallbackFailed"; failure_message = "Symbolic-link progress could not be delivered after publication."; }
  }
  struct stat source_after_callback{}, destination_after_callback{}, visible_after_callback{};
  const bool callback_source_same = fstat(source_link.get(), &source_after_callback) == 0 &&
      SameIdentity(source_after_callback, request.expected_source) &&
      fstatat(source_parent, source_name.c_str(), &source_named, AT_SYMLINK_NOFOLLOW) == 0 &&
      SameIdentity(source_named, request.expected_source);
  const bool callback_destination_same = fstat(destination_link.get(), &destination_after_callback) == 0 &&
      fstatat(target_parent, target_name.c_str(), &visible_after_callback, AT_SYMLINK_NOFOLLOW) == 0 &&
      S_ISLNK(visible_after_callback.st_mode) && SameDirectory(target_parent_path, target_parent, target_parent_before) &&
      destination_after_callback.st_dev == visible_after_callback.st_dev &&
      destination_after_callback.st_ino == visible_after_callback.st_ino &&
      SameIdentity(Identity(destination_after_callback), Identity(visible_after_callback));
  if (!callback_source_same || !callback_destination_same) {
    result->status = FileTransferStatus::kUnknown;
    result->code = "DestinationOwnershipUnknown";
    result->message = "The symbolic-link identities changed during final progress delivery.";
    result->expected_source = request.expected_source;
    if (!callback_source_same) result->observed_source = Identity(source_after_callback);
    return;
  }
  destination_final = destination_after_callback;
  if (!failure) {
    result->status = FileTransferStatus::kCommitted;
    result->code = "Committed";
    result->owned_destination = FileTransferOwnedDestination{Identity(destination_final)};
    return;
  }
  result->native_error = static_cast<uint32_t>(failure);
  result->cancelled = failure == ECANCELED || shutdown.load();
  result->status = FileTransferStatus::kPartial;
  result->code = result->cancelled ? "CancelledWithPartial" : failure_code;
  result->message = result->cancelled ? "The symbolic link was published before cancellation." : failure_message;
  result->owned_destination = FileTransferOwnedDestination{Identity(destination_final)};
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
  if (request.metadata_only) {
    CopyDirectoryMetadata(request, source_name, target_parent_path, target_name,
        source_parent.get(), target_parent.get(), parent_before, should_cancel, shutdown, result);
    return;
  }
  struct stat source_entry{};
  if (fstatat(source_parent.get(), source_name.c_str(), &source_entry, AT_SYMLINK_NOFOLLOW) == 0 && S_ISLNK(source_entry.st_mode)) {
    CopySymlink(request, source_name, target_parent_path, target_name,
        source_parent.get(), target_parent.get(), parent_before, should_cancel, on_progress, shutdown, result);
    return;
  }
  Descriptor source(openat(source_parent.get(), source_name.c_str(), O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC));
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
  std::vector<ExtendedAttribute> source_attributes;
  int metadata_error = 0;
  if (!ReadExtendedAttributes(source.get(), &source_attributes, &metadata_error)) {
    SetUnchanged(result, "MetadataReadFailed", "Source extended attributes could not be read completely.", metadata_error);
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
  const uint64_t total = source_info.st_size < 0 ? 0 : static_cast<uint64_t>(source_info.st_size);
  uint64_t logical_processed = 0;
  uint64_t data_bytes_written = 0;
  int failure = 0;
  const char* failure_code = "NativeFailure";
  const char* failure_message = "The native copy did not finish.";
  char buffer[256 * 1024];
  auto report_progress = [&]() {
    if (!on_progress) return true;
    FileTransferProgress progress{logical_processed, total, std::nullopt, logical_processed, data_bytes_written, "logical"};
    try { on_progress(progress); return true; }
    catch (...) { failure = ECANCELED; return false; }
  };
  if (source_info.st_size < 0) {
    failure = EOVERFLOW;
  } else if (ftruncate(destination.get(), source_info.st_size) != 0) {
    failure = errno;
  }

  bool sparse_layout = false;
  bool all_hole = false;
  off_t first_data = 0;
  if (!failure && total) {
    first_data = lseek(source.get(), 0, SEEK_DATA);
    if (first_data < 0) {
      if (errno == ENXIO) { sparse_layout = true; all_hole = true; }
      else if (errno == EINVAL || errno == ENOTSUP) {
        const uint64_t allocated = static_cast<uint64_t>(source_info.st_blocks) * 512U;
        if (allocated < total) { failure = errno; failure_code = "SparseLayoutUnsupported"; failure_message = "The source uses sparse storage that this filesystem cannot report."; }
      } else { failure = errno; }
    } else if (first_data > 0) {
      sparse_layout = true;
    } else {
      const off_t first_hole = lseek(source.get(), first_data, SEEK_HOLE);
      if (first_hole < 0) {
        if (errno == EINVAL || errno == ENOTSUP) {
          const uint64_t allocated = static_cast<uint64_t>(source_info.st_blocks) * 512U;
          if (allocated < total) { failure = errno; failure_code = "SparseLayoutUnsupported"; failure_message = "The source uses sparse storage that this filesystem cannot report."; }
        } else { failure = errno; }
      } else if (static_cast<uint64_t>(first_hole) < total) {
        sparse_layout = true;
      } else if (static_cast<uint64_t>(source_info.st_blocks) * 512U < total) {
        failure = EOPNOTSUPP;
        failure_code = "SparseLayoutUnsupported";
        failure_message = "The filesystem does not expose the source storage holes needed to preserve its sparse layout.";
      }
    }
  }

  const auto cancelled = [&]() { return shutdown.load() || (should_cancel && should_cancel()); };
  const auto write_extent = [&](off_t begin, off_t end) {
    off_t offset = begin;
    while (!failure && offset < end) {
      if (cancelled()) { failure = ECANCELED; return; }
      const size_t requested = static_cast<size_t>(std::min<off_t>(static_cast<off_t>(sizeof(buffer)), end - offset));
      const ssize_t count = pread(source.get(), buffer, requested, offset);
      if (count < 0) { if (errno == EINTR) continue; failure = errno; return; }
      if (count == 0) { failure = EIO; return; }
      size_t written = 0;
      while (written < static_cast<size_t>(count)) {
        const ssize_t amount = pwrite(destination.get(), buffer + written, static_cast<size_t>(count) - written,
            offset + static_cast<off_t>(written));
        if (amount < 0) { if (errno == EINTR) continue; failure = errno; return; }
        if (amount == 0) { failure = EIO; return; }
        written += static_cast<size_t>(amount);
        data_bytes_written += static_cast<uint64_t>(amount);
        offset += amount;
        logical_processed = static_cast<uint64_t>(offset);
        if (!report_progress()) return;
        if (cancelled()) { failure = ECANCELED; return; }
      }
    }
  };

  if (!failure && sparse_layout) {
    if (all_hole) {
      logical_processed = total;
      report_progress();
    } else {
      off_t offset = 0;
      while (!failure && static_cast<uint64_t>(offset) < total) {
        if (cancelled()) { failure = ECANCELED; break; }
        const off_t data = lseek(source.get(), offset, SEEK_DATA);
        if (data < 0) {
          if (errno == ENXIO) { logical_processed = total; report_progress(); break; }
          failure = errno;
          break;
        }
        if (static_cast<uint64_t>(data) > logical_processed) {
          logical_processed = static_cast<uint64_t>(data);
          if (!report_progress() || cancelled()) { if (!failure) failure = ECANCELED; break; }
        }
        const off_t hole = lseek(source.get(), data, SEEK_HOLE);
        if (hole < 0) { failure = errno; break; }
        const off_t end = std::min<off_t>(hole, source_info.st_size);
        if (end <= data) { failure = EIO; break; }
        write_extent(data, end);
        offset = end;
      }
    }
  } else if (!failure) {
    write_extent(0, source_info.st_size);
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
  if (!failure) {
    struct stat destination_before_metadata{};
    if (fstat(destination.get(), &destination_before_metadata) != 0) {
      failure = errno;
      failure_code = "MetadataFailure";
      failure_message = "The destination metadata could not be inspected.";
    } else if ((destination_before_metadata.st_uid != source_info.st_uid || destination_before_metadata.st_gid != source_info.st_gid) &&
               fchown(destination.get(), source_info.st_uid, source_info.st_gid) != 0) {
      failure = errno;
      failure_code = "MetadataFailure";
      failure_message = "The source owner and group could not be preserved.";
    }
  }
  if (!failure && !source_attributes.empty()) {
    if (fchmod(destination.get(), source_info.st_mode & 07777) != 0) {
      failure = errno;
      failure_code = "MetadataFailure";
      failure_message = "The source mode could not be preserved.";
    }
  } else if (!failure) {
    if (fremovexattr(destination.get(), "system.posix_acl_access") != 0 && errno != ENODATA && errno != ENOTSUP) {
      failure = errno;
      failure_code = "MetadataFailure";
      failure_message = "The inherited destination ACL could not be removed.";
    } else if (fchmod(destination.get(), source_info.st_mode & 07777) != 0) {
      failure = errno;
      failure_code = "MetadataFailure";
      failure_message = "The source mode could not be preserved.";
    }
  }
  if (!failure && !WriteAndVerifyExtendedAttributes(destination.get(), source_attributes, &metadata_error)) {
    failure = metadata_error;
    failure_code = "MetadataFailure";
    failure_message = "A source extended attribute could not be preserved exactly.";
  }
  if (!failure) {
    struct stat destination_metadata{};
    if (fstat(destination.get(), &destination_metadata) != 0) {
      failure = errno;
      failure_code = "MetadataFailure";
      failure_message = "The copied metadata could not be verified.";
    } else if (destination_metadata.st_uid != source_info.st_uid || destination_metadata.st_gid != source_info.st_gid ||
               (destination_metadata.st_mode & 07777) != (source_info.st_mode & 07777)) {
      failure = EIO;
      failure_code = "MetadataFailure";
      failure_message = "The copied owner, group, or mode differs from the source.";
    }
  }
  if (!failure) {
    const struct timespec times[2] = {source_info.st_atim, source_info.st_mtim};
    if (futimens(destination.get(), times) != 0) {
      failure = errno;
      failure_code = "MetadataFailure";
      failure_message = "The source access and modification times could not be preserved.";
    }
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
  if (!failure && logical_processed == total) {
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
  result->code = result->cancelled ? "Cancelled" : failure_code;
  result->message = result->cancelled ? "The copy was cancelled." : failure_message;
  if (same_signature) {
    result->status = FileTransferStatus::kPartial;
    result->owned_destination = FileTransferOwnedDestination{Identity(final_identity)};
    result->code = result->cancelled ? "CancelledWithPartial" : failure_code;
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

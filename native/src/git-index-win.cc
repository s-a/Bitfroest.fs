#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include <git2.h>
#include <node_api.h>
#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <memory>
#include <limits>
#include <stdexcept>
#include <set>
#include <string>
#include <vector>
#include "git-index-win.h"
#include "session.h"

struct GitIndexControl { std::atomic<unsigned> state{0}; };
struct GitIndexSessionState {
  std::set<std::shared_ptr<GitIndexControl>> active;
  std::vector<napi_deferred> closing;
};

namespace {
struct Failure : std::runtime_error {
  std::string code;
  Failure(const char* kind, const char* message) : std::runtime_error(message), code(kind) {}
};
void Require(bool condition, const char* code, const char* message) { if (!condition) throw Failure(code, message); }
void Git(int result, const char* code, const char* message) { Require(result >= 0, code, message); }
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE handle = INVALID_HANDLE_VALUE) : value(handle) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};
struct Lock : Handle {
  bool committed = false;
  explicit Lock(const std::wstring& filename) : Handle(CreateFileW(filename.c_str(), GENERIC_READ | GENERIC_WRITE | DELETE,
      FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)) {
    Require(value != INVALID_HANDLE_VALUE, GetLastError() == ERROR_FILE_EXISTS || GetLastError() == ERROR_ALREADY_EXISTS ? "IndexLocked" : "IndexAccessDenied", "The Git index lock could not be acquired.");
  }
  ~Lock() { if (!committed && value != INVALID_HANDLE_VALUE) { FILE_DISPOSITION_INFO remove{TRUE}; SetFileInformationByHandle(value, FileDispositionInfo, &remove, sizeof(remove)); } }
};
struct Temporary {
  std::wstring path;
  Temporary() {
    wchar_t directory[MAX_PATH + 1]{}, name[MAX_PATH + 1]{};
    const DWORD size = GetTempPathW(MAX_PATH, directory);
    Require(size && size < MAX_PATH && GetTempFileNameW(directory, L"bgi", 0, name), "TemporaryUnavailable", "A temporary Git index could not be created.");
    path = name;
  }
  ~Temporary() { DeleteFileW(path.c_str()); DeleteFileW((path + L".lock").c_str()); }
};
using Control = GitIndexControl;
struct Job {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::shared_ptr<SessionState> session;
  std::shared_ptr<Control> control = std::make_shared<Control>();
  std::string root, target, expected_head, expected_reference, expected_index, expected_ino, error, code;
  bool committed = false;
  DWORD native_error = 0;
};
bool ReadString(napi_env env, napi_value object, const char* name, std::string& output) {
  napi_value value;
  size_t length = 0;
  if (napi_get_named_property(env, object, name, &value) != napi_ok || napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length > 32767) return false;
  std::vector<char> buffer(length + 1);
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
  output.assign(buffer.data(), length);
  return output.find('\0') == std::string::npos;
}
std::vector<unsigned char> Read(HANDLE file) {
  LARGE_INTEGER size{}, zero{};
  Require(GetFileSizeEx(file, &size) && size.QuadPart >= 0 && static_cast<uint64_t>(size.QuadPart) <= SIZE_MAX && SetFilePointerEx(file, zero, nullptr, FILE_BEGIN), "IndexReadFailed", "The Git index could not be read.");
  std::vector<unsigned char> bytes(static_cast<size_t>(size.QuadPart));
  size_t offset = 0;
  while (offset < bytes.size()) {
    DWORD read = 0;
    const DWORD chunk = static_cast<DWORD>(std::min<size_t>(bytes.size() - offset, MAXDWORD));
    Require(ReadFile(file, bytes.data() + offset, chunk, &read, nullptr) && read, "IndexReadFailed", "The Git index read was incomplete.");
    offset += read;
  }
  return bytes;
}
void Write(HANDLE file, const std::vector<unsigned char>& bytes) {
  LARGE_INTEGER zero{};
  Require(SetFilePointerEx(file, zero, nullptr, FILE_BEGIN), "IndexWriteFailed", "The Git index could not be written.");
  size_t offset = 0;
  while (offset < bytes.size()) {
    DWORD written = 0;
    const DWORD chunk = static_cast<DWORD>(std::min<size_t>(bytes.size() - offset, MAXDWORD));
    Require(WriteFile(file, bytes.data() + offset, chunk, &written, nullptr) && written, "IndexWriteFailed", "The Git index write was incomplete.");
    offset += written;
  }
  Require(SetEndOfFile(file) && FlushFileBuffers(file), "IndexWriteFailed", "The Git index could not be flushed.");
}
std::string Digest(const std::vector<unsigned char>& bytes) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  Require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "HashUnavailable", "The index digest could not be computed.");
  struct AlgorithmGuard { BCRYPT_ALG_HANDLE value; ~AlgorithmGuard() { BCryptCloseAlgorithmProvider(value, 0); } } guard{algorithm};
  BCRYPT_HASH_HANDLE hash = nullptr;
  Require(BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) >= 0, "HashUnavailable", "The index digest could not be computed.");
  struct HashGuard { BCRYPT_HASH_HANDLE value; ~HashGuard() { BCryptDestroyHash(value); } } hash_guard{hash};
  size_t offset = 0;
  while (offset < bytes.size()) {
    const ULONG chunk = static_cast<ULONG>(std::min<size_t>(bytes.size() - offset, std::numeric_limits<ULONG>::max()));
    Require(BCryptHashData(hash, const_cast<PUCHAR>(bytes.data() + offset), chunk, 0) >= 0, "HashUnavailable", "The index digest could not be computed.");
    offset += chunk;
  }
  unsigned char result[32]{};
  Require(BCryptFinishHash(hash, result, sizeof(result), 0) >= 0, "HashUnavailable", "The index digest could not be computed.");
  static const char digits[] = "0123456789abcdef";
  std::string output;
  for (const auto byte : result) { output += digits[byte >> 4]; output += digits[byte & 15]; }
  return output;
}
void NoReparse(const std::filesystem::path& value) {
  std::filesystem::path current;
  for (const auto& part : value) {
    current /= part;
    if (!current.has_root_directory()) continue;
    const DWORD attributes = GetFileAttributesW(current.c_str());
    Require(attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_REPARSE_POINT), "UnsafePath", "Git index actions do not follow reparse points.");
    if (attributes & FILE_ATTRIBUTE_DIRECTORY) {
      Handle directory(CreateFileW(current.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
          nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
      Require(directory.value != INVALID_HANDLE_VALUE, "UnsafePath", "Directory attributes could not be checked.");
      FILE_CASE_SENSITIVE_INFO sensitive{};
      const BOOL described = GetFileInformationByHandleEx(directory.value, FileCaseSensitiveInfo, &sensitive, sizeof(sensitive));
      Require(!described || !(sensitive.Flags & FILE_CS_FLAG_CASE_SENSITIVE_DIR), "UnsupportedRepository", "Case-sensitive Windows directories are unsupported by Git index actions.");
    }
  }
}
std::string Head(git_repository* repository) {
  git_reference* raw = nullptr;
  const int result = git_repository_head(&raw, repository);
  std::unique_ptr<git_reference, decltype(&git_reference_free)> reference(raw, git_reference_free);
  if (result == GIT_EUNBORNBRANCH || result == GIT_ENOTFOUND) return "";
  Git(result, "HeadUnavailable", "The Git HEAD could not be read.");
  char text[GIT_OID_HEXSZ + 1]{};
  git_oid_tostr(text, sizeof(text), git_reference_target(reference.get()));
  return text;
}
void CheckCancelled(Job* job) { Require(!job->session->closed.load() && job->control->state.load() != 1, "Cancelled", "The Git index action was cancelled before publication."); }
uint64_t Identity(HANDLE file) {
  BY_HANDLE_FILE_INFORMATION information{};
  Require(GetFileInformationByHandle(file, &information), "FileAccessDenied", "The selected file identity could not be read.");
  Require(!(information.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)), "UnsafePath", "The selected path must be a regular file.");
  return static_cast<uint64_t>(information.nFileIndexHigh) << 32 | information.nFileIndexLow;
}
void Execute(napi_env, void* data) {
  auto* job = static_cast<Job*>(data);
  bool initialized = false;
  try {
    CheckCancelled(job);
    Git(git_libgit2_init(), "GitInitializationFailed", "The Git runtime could not be initialized."); initialized = true;
    const auto root = std::filesystem::u8path(job->root).lexically_normal().make_preferred();
    const auto target = std::filesystem::u8path(job->target).lexically_normal().make_preferred();
    Require(root.is_absolute() && target.is_absolute(), "UnsafePath", "Absolute Git paths are required.");
    NoReparse(root); NoReparse(target);
    std::wstring prefix = root.wstring();
    if (prefix.back() != L'\\') prefix += L'\\';
    const std::wstring target_text = target.wstring();
    Require(target_text.size() > prefix.size() && _wcsnicmp(prefix.c_str(), target_text.c_str(), prefix.size()) == 0,
        "UnsafePath", "The selected file is outside the repository.");
    std::string scope = std::filesystem::path(target_text.substr(prefix.size())).generic_u8string();
    Require(!scope.empty() && scope.find(':') == std::string::npos && scope.rfind(".git/", 0) != 0 && scope != ".git", "UnsafePath", "The selected file is outside the repository.");
    Require(!(GetFileAttributesW(target.c_str()) & FILE_ATTRIBUTE_DIRECTORY), "UnsafePath", "The selected path must be a regular file.");
    Handle local(CreateFileW(target.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    Require(local.value != INVALID_HANDLE_VALUE, "FileAccessDenied", "The selected file could not be locked for reading.");
    Require(std::to_string(Identity(local.value)) == job->expected_ino, "StaleFile", "The selected file identity has changed.");
    git_repository* raw_repository = nullptr;
    Git(git_repository_open_ext(&raw_repository, job->root.c_str(), GIT_REPOSITORY_OPEN_NO_SEARCH, nullptr), "RepositoryUnavailable", "The exact Git repository could not be opened.");
    std::unique_ptr<git_repository, decltype(&git_repository_free)> repository(raw_repository, git_repository_free);
    Require(!git_repository_is_bare(repository.get()) && git_repository_workdir(repository.get()), "RepositoryUnavailable", "A working-tree repository is required.");
    const auto actual_root = std::filesystem::u8path(git_repository_workdir(repository.get())).lexically_normal().make_preferred();
    Require(_wcsicmp(actual_root.c_str(), (root / L"").c_str()) == 0 || _wcsicmp(actual_root.c_str(), root.c_str()) == 0, "RepositoryMismatch", "The repository root has changed.");
    const auto index_path = std::filesystem::u8path(git_repository_path(repository.get())) / L"index";
    NoReparse(index_path);
    Lock lock(index_path.wstring() + L".lock");
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
      Require(branch_result == GIT_ENOTFOUND || branch_result == 0 && git_reference_type(branch.get()) == GIT_REFERENCE_DIRECT,
          "UnsupportedRepository", "Symbolic branch aliases are unsupported by Git index actions.");
    }
    Require(Head(repository.get()) == job->expected_head, "StaleHead", "The Git HEAD has changed.");
    Handle source(CreateFileW(index_path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    Require(source.value != INVALID_HANDLE_VALUE, "IndexAccessDenied", "The Git index could not be opened.");
    const auto bytes = Read(source.value);
    Require(Digest(bytes) == job->expected_index, "StaleIndex", "The Git index has changed.");
    Temporary temporary;
    { Handle file(CreateFileW(temporary.path.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)); Require(file.value != INVALID_HANDLE_VALUE, "TemporaryUnavailable", "The temporary index could not be opened."); Write(file.value, bytes); }
    git_index* raw_index = nullptr;
    const std::string temporary_utf8 = std::filesystem::path(temporary.path).u8string();
    Git(git_index_open(&raw_index, temporary_utf8.c_str()), "UnsupportedIndex", "The Git index format is unsupported or invalid.");
    std::unique_ptr<git_index, decltype(&git_index_free)> index(raw_index, git_index_free);
    git_index* raw_repository_index = nullptr;
    Git(git_repository_index(&raw_repository_index, repository.get()), "UnsupportedIndex", "The repository index capabilities could not be read.");
    std::unique_ptr<git_index, decltype(&git_index_free)> repository_index(raw_repository_index, git_index_free);
    Git(git_index_set_caps(index.get(), git_index_caps(repository_index.get())), "UnsupportedIndex", "The repository index capabilities are unsupported.");
    for (size_t i = 0; i < git_index_entrycount(index.get()); ++i) Require(!(git_index_get_byindex(index.get(), i)->flags_extended & GIT_INDEX_ENTRY_SKIP_WORKTREE), "UnsupportedIndex", "Sparse indexes are not supported by this action.");
    Require(!git_index_get_bypath(index.get(), scope.c_str(), 1) && !git_index_get_bypath(index.get(), scope.c_str(), 2) && !git_index_get_bypath(index.get(), scope.c_str(), 3), "ConflictedIndex", "The selected file has unresolved merge conflicts.");
    const auto wide_scope = std::filesystem::u8path(scope).wstring();
    const git_index_entry* entry = nullptr;
    for (size_t i = 0; i < git_index_entrycount(index.get()); ++i) {
      const git_index_entry* candidate = git_index_get_byindex(index.get(), i);
      if (GIT_INDEX_ENTRY_STAGE(candidate)) continue;
      const auto wide_candidate = std::filesystem::u8path(candidate->path).wstring();
      if (CompareStringOrdinal(wide_scope.c_str(), -1, wide_candidate.c_str(), -1, TRUE) != CSTR_EQUAL) continue;
      Require(!entry, "UnsupportedIndex", "The Git index contains case-colliding paths for the selected file.");
      entry = candidate;
    }
    Require(entry, "NotTracked", "The selected file is not in the Git index.");
    scope = entry->path;
    Require(entry->mode == GIT_FILEMODE_BLOB || entry->mode == GIT_FILEMODE_BLOB_EXECUTABLE, "UnsafePath", "Only regular indexed files are supported.");
    bool in_head = false;
    git_object* raw_head = nullptr;
    if (!job->expected_head.empty()) {
      Git(git_revparse_single(&raw_head, repository.get(), "HEAD^{tree}"), "HeadUnavailable", "The committed tree could not be read.");
      std::unique_ptr<git_object, decltype(&git_object_free)> head(raw_head, git_object_free);
      git_tree_entry* raw_entry = nullptr;
      const int result = git_tree_entry_bypath(&raw_entry, reinterpret_cast<git_tree*>(head.get()), scope.c_str());
      std::unique_ptr<git_tree_entry, decltype(&git_tree_entry_free)> head_entry(raw_entry, git_tree_entry_free);
      Require(result == 0 || result == GIT_ENOTFOUND, "HeadUnavailable", "The committed file could not be read.");
      in_head = result == 0 && git_oid_equal(&entry->id, git_tree_entry_id(head_entry.get())) && entry->mode == static_cast<uint32_t>(git_tree_entry_filemode(head_entry.get()));
    }
    if (!in_head) {
      git_oid local_oid{};
      Git(git_repository_hashfile(&local_oid, repository.get(), scope.c_str(), GIT_OBJECT_BLOB, scope.c_str()), "FileReadFailed", "The selected file content could not be verified.");
      Require(git_oid_equal(&entry->id, &local_oid), "StagedChanges", "The staged file content is not retained in HEAD or the local file.");
    }
    CheckCancelled(job);
    Git(git_index_remove_bypath(index.get(), scope.c_str()), "IndexWriteFailed", "The selected index entry could not be removed.");
    Git(git_index_write(index.get()), "IndexWriteFailed", "The temporary Git index could not be serialized.");
    std::vector<unsigned char> updated;
    { Handle file(CreateFileW(temporary.path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)); Require(file.value != INVALID_HANDLE_VALUE, "TemporaryUnavailable", "The serialized Git index could not be read."); updated = Read(file.value); }
    Write(lock.value, updated);
    Require(Head(repository.get()) == job->expected_head && Digest(Read(source.value)) == job->expected_index, "StaleIndex", "Repository identity changed before publication.");
    Require(std::to_string(Identity(local.value)) == job->expected_ino, "StaleFile", "The selected file identity has changed.");
    CheckCancelled(job);
    const std::wstring destination = index_path.wstring();
    const size_t info_size = offsetof(FILE_RENAME_INFO, FileName) + (destination.size() + 1) * sizeof(wchar_t);
    std::vector<unsigned char> info_bytes(info_size);
    auto* info = reinterpret_cast<FILE_RENAME_INFO*>(info_bytes.data());
    info->ReplaceIfExists = TRUE; info->RootDirectory = nullptr; info->FileNameLength = static_cast<DWORD>(destination.size() * sizeof(wchar_t));
    std::memcpy(info->FileName, destination.data(), info->FileNameLength);
    CloseHandle(source.value); source.value = INVALID_HANDLE_VALUE;
    unsigned expected_state = 0;
    Require(job->control->state.compare_exchange_strong(expected_state, 2), "Cancelled", "The Git index action was cancelled before publication.");
    const BOOL renamed = SetFileInformationByHandle(lock.value, FileRenameInfo, info, static_cast<DWORD>(info_size));
    if (!renamed) job->native_error = GetLastError();
    Require(renamed, "IndexPublishFailed", "The new Git index could not be published atomically.");
    lock.committed = true; job->committed = true; job->control->state.store(3);
  } catch (const Failure& error) { job->code = error.code; job->error = error.what(); }
    catch (const std::bad_alloc&) { job->code = "ResourceExhausted"; job->error = "The Git index action could not allocate resources."; }
    catch (...) { job->code = "GitIndexFailure"; job->error = "The Git index action failed."; }
  if (initialized) git_libgit2_shutdown();
}
napi_value Text(napi_env env, const std::string& text) { napi_value value; if (napi_create_string_utf8(env, text.c_str(), text.size(), &value) != napi_ok) return nullptr; return value; }
void Complete(napi_env env, napi_status status, void* data) {
  std::unique_ptr<Job> job(static_cast<Job*>(data));
  napi_value result, value;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "status", Text(env, job->committed ? "committed" : "unchanged"));
  if (status == napi_ok && job->error.empty()) {
    napi_get_boolean(env, true, &value); napi_set_named_property(env, result, "removed", value);
    napi_resolve_deferred(env, job->deferred, result);
  } else {
    napi_value error;
    napi_create_error(env, Text(env, job->code.empty() ? "Cancelled" : job->code), Text(env, job->error.empty() ? "The Git index action was cancelled." : job->error), &error);
    napi_set_named_property(env, error, "outcome", result);
    napi_create_uint32(env, job->native_error, &value); napi_set_named_property(env, error, "nativeCode", value);
    napi_reject_deferred(env, job->deferred, error);
  }
  napi_delete_async_work(env, job->work);
  const auto lifecycle = job->session->git_index_session;
  lifecycle->active.erase(job->control);
  if (lifecycle->active.empty()) {
    napi_value undefined; napi_get_undefined(env, &undefined);
    for (auto waiter : lifecycle->closing) napi_resolve_deferred(env, waiter, undefined);
    lifecycle->closing.clear();
  }
}
napi_value Cancel(napi_env env, napi_callback_info info) {
  void* data = nullptr; napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &data);
  auto& control = *static_cast<std::shared_ptr<Control>*>(data);
  unsigned expected = 0;
  const bool changed = control->state.compare_exchange_strong(expected, 1);
  napi_value result; napi_get_boolean(env, changed, &result); return result;
}
}
napi_value StartGitUntrack(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request) {
  auto job = std::make_unique<Job>(); job->session = state;
  if (!state->git_index_session) state->git_index_session = std::make_shared<GitIndexSessionState>();
  if (!ReadString(env, request, "repositoryRoot", job->root) || !ReadString(env, request, "target", job->target) ||
      !ReadString(env, request, "expectedHead", job->expected_head) || !ReadString(env, request, "expectedReference", job->expected_reference) || !ReadString(env, request, "expectedIndex", job->expected_index) || !ReadString(env, request, "expectedIno", job->expected_ino) ||
      job->expected_index.size() != 64 || job->expected_ino.empty() || job->expected_ino.size() > 20 ||
      !std::all_of(job->expected_ino.begin(), job->expected_ino.end(), [](char c) { return c >= '0' && c <= '9'; })) {
    napi_throw_error(env, "InvalidRequest", "Git index actions require captured repository, file, HEAD and index identities."); return nullptr;
  }
  napi_value promise, resource = Text(env, "git.untrack"), cancel;
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok || napi_create_async_work(env, nullptr, resource, Execute, Complete, job.get(), &job->work) != napi_ok) return nullptr;
  auto* control = new std::shared_ptr<Control>(job->control);
  if (napi_create_function(env, "cancel", NAPI_AUTO_LENGTH, Cancel, control, &cancel) != napi_ok ||
      napi_add_finalizer(env, cancel, control, [](napi_env, void* data, void*) { delete static_cast<std::shared_ptr<Control>*>(data); }, nullptr, nullptr) != napi_ok ||
      napi_set_named_property(env, promise, "cancel", cancel) != napi_ok) {
    napi_delete_async_work(env, job->work); return nullptr;
  }
  state->git_index_session->active.insert(job->control);
  if (napi_queue_async_work(env, job->work) != napi_ok) { state->git_index_session->active.erase(job->control); napi_delete_async_work(env, job->work); return nullptr; }
  job.release(); return promise;
}

napi_value CloseGitIndexSession(napi_env env, const std::shared_ptr<SessionState>& state) {
  napi_deferred deferred; napi_value promise, undefined;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok || napi_get_undefined(env, &undefined) != napi_ok) return nullptr;
  const auto lifecycle = state->git_index_session;
  if (!lifecycle || lifecycle->active.empty()) napi_resolve_deferred(env, deferred, undefined);
  else {
    for (const auto& control : lifecycle->active) { unsigned expected = 0; control->state.compare_exchange_strong(expected, 1); }
    lifecycle->closing.push_back(deferred);
  }
  return promise;
}

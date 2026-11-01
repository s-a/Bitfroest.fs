#include "git-status-native.h"
#include <git2.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <cstring>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <iterator>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>
#include <sys/stat.h>
#ifdef _WIN32
#include <git2/sys/config.h>
#include <git2/sys/repository.h>
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#endif

namespace {
struct GitStatusRuntime;
constexpr napi_type_tag kGitStatusPromiseTag = {0x8f4a2b709d61c3e5ULL, 0x14e7b0a62f985d31ULL};

struct GitStatusJob {
  GitStatusRuntime* runtime = nullptr;
  std::shared_ptr<SessionState> state;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  napi_ref promise = nullptr;
  napi_threadsafe_function progress = nullptr;
  std::shared_ptr<struct GitStatusProgressState> progressState;
  git_repository* repository = nullptr;
  git_index* index = nullptr;
  git_tree* headTree = nullptr;
  git_diff* stagedDiff = nullptr;
  git_diff* worktreeDiff = nullptr;
  std::string directory;
  std::string scope;
  std::string root;
  std::string gitdir;
  std::string branch;
  std::string head;
  std::vector<std::string> localBranches;
  std::vector<std::string> remoteBranches;
  std::string message;
  std::string code;
  std::atomic<bool> cancelled{false};
  int result = 0;
  bool repository_found = false;
  bool include_ignored = false;
  bool recursive = true;
  bool detached = false;
  bool unborn = false;
  bool infoOnly = false;
  bool summary = false;
  bool dirty = false;
  std::string dirtyPath;
  bool summaryCheckingWorktree = false;
  bool normalizeCrlf = false;
  int64_t summaryIndexTime = 0;
  bool summaryIndexTimeValid = false;
  int indexVersion = 0;
  bool skipWorktree = false;
  bool sparseCheckout = false;
  std::string autocrlf;
  std::vector<std::string> includeScopes;
  std::vector<std::string> excludeScopes;
  std::vector<std::string> pathspecStorage;
  std::vector<char*> pathspecPointers;
  bool noSelectedPaths = false;
  struct Entry { int head = 1; int workdir = 1; int stage = 1; bool ignored = false; bool conflicted = false; };
  std::map<std::string, Entry> entries;
};

struct GitStatusProgressState {
  std::atomic<bool> callbackFailed{false};
  std::atomic<bool> allocationFailed{false};
};
struct GitStatusProgress { std::string path; std::shared_ptr<GitStatusProgressState> state; };

struct GitStatusRuntime {
  std::mutex mutex;
  std::set<GitStatusJob*> active;
  bool closing = false;
  bool initialized = false;
};

napi_value String(napi_env env, const std::string& value) {
  napi_value result;
  if (napi_create_string_utf8(env, value.c_str(), value.size(), &result) != napi_ok) return nullptr;
  return result;
}

bool ReadString(napi_env env, napi_value object, const char* name, std::string& value) {
  napi_value property;
  bool has = false;
  if (napi_has_named_property(env, object, name, &has) != napi_ok || !has) return false;
  if (napi_get_named_property(env, object, name, &property) != napi_ok) return false;
  napi_valuetype type;
  if (napi_typeof(env, property, &type) != napi_ok || type != napi_string) return false;
  size_t size = 0;
  if (napi_get_value_string_utf8(env, property, nullptr, 0, &size) != napi_ok) return false;
  value.resize(size + 1);
  const bool read = napi_get_value_string_utf8(env, property, value.data(), size + 1, &size) == napi_ok;
  if (read) value.resize(size);
  return read;
}

bool ReadBoolean(napi_env env, napi_value object, const char* name, bool fallback) {
  napi_value property;
  bool has = false;
  if (napi_has_named_property(env, object, name, &has) != napi_ok || !has) return fallback;
  if (napi_get_named_property(env, object, name, &property) != napi_ok) return fallback;
  bool result = fallback;
  napi_get_value_bool(env, property, &result);
  return result;
}

bool ValidBoolean(napi_env env, napi_value object, const char* name) {
  napi_value property;
  bool has = false;
  if (napi_has_named_property(env, object, name, &has) != napi_ok || !has) return true;
  if (napi_get_named_property(env, object, name, &property) != napi_ok) return false;
  napi_valuetype type;
  return napi_typeof(env, property, &type) == napi_ok && type == napi_boolean;
}

bool ValidRelativeScope(const std::string& value, bool allowRoot) {
  if (value.size() > 32767 || value.find('\0') != std::string::npos || value.find('\\') != std::string::npos ||
      std::any_of(value.begin(), value.end(), [](unsigned char character) { return character < 0x20; })) return false;
  if (value == ".") return allowRoot;
  if (value.empty() || value.front() == '/' || value.back() == '/' || value.find("//") != std::string::npos) return false;
  const std::filesystem::path scope = std::filesystem::u8path(value);
  if (scope.has_root_name() || scope.has_root_directory() || scope.is_absolute()) return false;
  size_t start = 0;
  while (start < value.size()) {
    const size_t end = value.find('/', start);
    const size_t length = (end == std::string::npos ? value.size() : end) - start;
    if (!length || value.compare(start, length, ".") == 0 || value.compare(start, length, "..") == 0) return false;
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return true;
}

bool ReadStringArray(napi_env env, napi_value object, const char* name, std::vector<std::string>& values) {
  napi_value property;
  bool has = false;
  if (napi_has_named_property(env, object, name, &has) != napi_ok || !has) return true;
  if (napi_get_named_property(env, object, name, &property) != napi_ok) return false;
  bool array = false;
  if (napi_is_array(env, property, &array) != napi_ok || !array) return false;
  uint32_t length = 0;
  if (napi_get_array_length(env, property, &length) != napi_ok || length > 4096) return false;
  for (uint32_t i = 0; i < length; i++) {
    napi_value item;
    napi_valuetype type;
    if (napi_get_element(env, property, i, &item) != napi_ok || napi_typeof(env, item, &type) != napi_ok || type != napi_string) return false;
    size_t size = 0;
    if (napi_get_value_string_utf8(env, item, nullptr, 0, &size) != napi_ok) return false;
    std::string value(size + 1, '\0');
    if (napi_get_value_string_utf8(env, item, value.data(), size + 1, &size) != napi_ok) return false;
    value.resize(size);
    if (!ValidRelativeScope(value, true)) return false;
    values.push_back(std::move(value));
  }
  return true;
}

bool Set(napi_env env, napi_value object, const char* name, napi_value value) {
  return value && napi_set_named_property(env, object, name, value) == napi_ok;
}

napi_value Boolean(napi_env env, bool value) {
  napi_value result;
  if (napi_get_boolean(env, value, &result) != napi_ok) return nullptr;
  return result;
}

napi_value Number(napi_env env, uint32_t value) {
  napi_value result;
  if (napi_create_uint32(env, value, &result) != napi_ok) return nullptr;
  return result;
}

napi_value ErrorValue(napi_env env, const char* code, const char* message) {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
    napi_value exception;
    if (napi_get_and_clear_last_exception(env, &exception) == napi_ok) return exception;
  }
  napi_value errorCode = String(env, code), errorMessage = String(env, message), error = nullptr;
  if (!errorCode || !errorMessage || napi_create_error(env, errorCode, errorMessage, &error) != napi_ok) {
    pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending && napi_get_and_clear_last_exception(env, &error) == napi_ok) return error;
    if (napi_get_undefined(env, &error) != napi_ok) return nullptr;
  }
  return error;
}

void Reject(napi_env env, napi_deferred deferred, const char* code, const char* message) {
  napi_value error = ErrorValue(env, code, message);
  if (!error) {
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) napi_get_and_clear_last_exception(env, &error);
    if (!error) napi_get_undefined(env, &error);
  }
  if (error) napi_reject_deferred(env, deferred, error);
}

void SetError(GitStatusJob* job, int result, const char* fallback) {
  const git_error* error = git_error_last();
  job->result = result;
  job->code = result == GIT_ENOTFOUND ? "NotFoundError" : "GitFailure";
  job->message = error && error->message ? error->message : fallback;
}

void CallStatusProgress(napi_env env, napi_value callback, void*, void* data) {
  std::unique_ptr<GitStatusProgress> progress(static_cast<GitStatusProgress*>(data));
  if (!env || !callback || !progress) return;
  napi_value global, event, file;
  if (napi_get_global(env, &global) != napi_ok || napi_create_object(env, &event) != napi_ok ||
      napi_create_string_utf8(env, progress->path.c_str(), progress->path.size(), &file) != napi_ok ||
      napi_set_named_property(env, event, "path", file) != napi_ok) {
    if (progress->state) progress->state->callbackFailed.store(true);
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
      napi_value exception;
      napi_get_and_clear_last_exception(env, &exception);
    }
    return;
  }
  napi_value ignored;
  if (napi_call_function(env, global, callback, 1, &event, &ignored) != napi_ok) {
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
      napi_value exception;
      napi_get_and_clear_last_exception(env, &exception);
    }
    if (progress->state) progress->state->callbackFailed.store(true);
  }
}

int CancelOnProgress(const git_diff*, const char* old_path, const char* new_path, void* payload) {
  auto* job = static_cast<GitStatusJob*>(payload);
  try {
    if (job->cancelled.load() || job->state->closed.load() || (job->progressState && job->progressState->callbackFailed.load()) ||
        (job->progressState && job->progressState->allocationFailed.load())) return GIT_EUSER;
    if (job->progress) {
      const char* path = new_path ? new_path : old_path;
      if (path) {
        auto* event = new (std::nothrow) GitStatusProgress{path, job->progressState};
        if (!event) {
          if (job->progressState) job->progressState->allocationFailed.store(true);
          return GIT_EUSER;
        }
        if (napi_call_threadsafe_function(job->progress, event, napi_tsfn_nonblocking) != napi_ok) delete event;
      }
    }
    return 0;
  } catch (const std::bad_alloc&) {
    if (job->progressState) job->progressState->allocationFailed.store(true);
    return GIT_EUSER;
  } catch (...) {
    if (job->progressState) job->progressState->allocationFailed.store(true);
    return GIT_ERROR;
  }
}

std::string NormalizeScope(const std::string& scope) {
  return scope == "." ? std::string() : scope;
}

std::string JoinScope(const std::string& parent, const std::string& child) {
  if (parent.empty() || parent == ".") return child;
  if (child.empty()) return parent;
  return parent + "/" + child;
}

bool ScopeContains(const std::string& parentValue, const std::string& childValue) {
  auto components = [](const std::string& value) {
    std::vector<std::string> parts;
    const std::string normalized = NormalizeScope(value);
    size_t start = 0;
    while (start < normalized.size()) {
      const size_t end = normalized.find('/', start);
      const size_t length = (end == std::string::npos ? normalized.size() : end) - start;
      parts.emplace_back(normalized.data() + start, length);
      if (end == std::string::npos) break;
      start = end + 1;
    }
    return parts;
  };
  const auto parent = components(parentValue), child = components(childValue);
  if (parent.size() > child.size()) return false;
  for (size_t i = 0; i < parent.size(); i++) {
    const std::string_view left = parent[i], right = child[i];
#ifdef _WIN32
    const int leftSize = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, left.data(), static_cast<int>(left.size()), nullptr, 0);
    const int rightSize = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, right.data(), static_cast<int>(right.size()), nullptr, 0);
    if (leftSize <= 0 || rightSize <= 0) { if (left != right) return false; else continue; }
    std::wstring leftWide(static_cast<size_t>(leftSize), L'\0'), rightWide(static_cast<size_t>(rightSize), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, left.data(), static_cast<int>(left.size()), leftWide.data(), leftSize) != leftSize ||
        MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, right.data(), static_cast<int>(right.size()), rightWide.data(), rightSize) != rightSize ||
        CompareStringOrdinal(leftWide.data(), leftSize, rightWide.data(), rightSize, TRUE) != CSTR_EQUAL) return false;
#else
    if (left != right) return false;
#endif
  }
  return true;
}

bool ScopeIsExcluded(const std::string& scope, const std::vector<std::string>& excludes) {
  return std::any_of(excludes.begin(), excludes.end(), [&](const auto& exclude) { return ScopeContains(exclude, scope); });
}

bool ScopeHasExcludedDescendant(const std::string& scope, const std::vector<std::string>& excludes) {
  return std::any_of(excludes.begin(), excludes.end(), [&](const auto& exclude) {
    return ScopeContains(scope, exclude) && NormalizeScope(scope) != NormalizeScope(exclude);
  });
}

bool ScopeAllowed(const std::string& scope, const GitStatusJob* job) {
  if (!job->includeScopes.empty() && !std::any_of(job->includeScopes.begin(), job->includeScopes.end(), [&](const auto& include) { return ScopeContains(include, scope); })) return false;
  return !ScopeIsExcluded(scope, job->excludeScopes);
}

int TreeForScope(git_tree** out, GitStatusJob* job, const std::string& scope) {
  *out = nullptr;
  if (!job->headTree) return GIT_ENOTFOUND;
  const std::string normalized = NormalizeScope(scope);
  if (normalized.empty()) {
    *out = job->headTree;
    return 0;
  }
  git_tree_entry* entry = nullptr;
  int result = git_tree_entry_bypath(&entry, job->headTree, normalized.c_str());
  if (result < 0) return result;
  if (git_tree_entry_type(entry) != GIT_OBJECT_TREE) {
    git_tree_entry_free(entry);
    return GIT_ENOTFOUND;
  }
  result = git_tree_lookup(out, job->repository, git_tree_entry_id(entry));
  git_tree_entry_free(entry);
  return result;
}

int CollectImmediateChildren(GitStatusJob* job, const std::string& scope, std::set<std::string>& names, std::set<std::string>& directories) {
  const std::string normalized = NormalizeScope(scope);
  std::filesystem::path directory = std::filesystem::u8path(job->root);
  if (!normalized.empty()) directory /= std::filesystem::u8path(normalized);
  std::error_code error;
  std::filesystem::directory_iterator iterator(directory, error), end;
  if (error && error != std::errc::no_such_file_or_directory && error != std::errc::not_a_directory) return GIT_ERROR;
  for (; !error && iterator != end; iterator.increment(error)) {
    const std::string name = iterator->path().filename().u8string();
    if (name.empty() || (normalized.empty() && name == ".git")) continue;
    names.insert(name);
    const auto status = iterator->symlink_status(error);
    if (error) return GIT_ERROR;
    if (std::filesystem::is_directory(status)) directories.insert(name);
  }
  if (error) return GIT_ERROR;
  const std::string prefix = normalized.empty() ? std::string() : normalized + "/";
  for (size_t i = 0; i < git_index_entrycount(job->index); i++) {
    const git_index_entry* entry = git_index_get_byindex(job->index, i);
    if (!entry || !entry->path) continue;
    const std::string path = entry->path;
    if (path.compare(0, prefix.size(), prefix) != 0 || path.size() <= prefix.size()) continue;
    const std::string rest = path.substr(prefix.size());
    const size_t slash = rest.find('/');
    const std::string child = rest.substr(0, slash);
    names.insert(child);
    if (slash != std::string::npos) directories.insert(child);
  }
  git_tree* tree = nullptr;
  int result = TreeForScope(&tree, job, normalized);
  if (result == 0 && tree) {
    for (size_t i = 0; i < git_tree_entrycount(tree); i++) {
      const git_tree_entry* entry = git_tree_entry_byindex(tree, i);
      if (!entry || !git_tree_entry_name(entry)) continue;
      const std::string child = git_tree_entry_name(entry);
      names.insert(child);
      if (git_tree_entry_type(entry) == GIT_OBJECT_TREE) directories.insert(child);
    }
    if (tree != job->headTree) git_tree_free(tree);
  } else if (result != GIT_ENOTFOUND) return result;
  return 0;
}

std::string CanonicalizeScope(GitStatusJob* job, const std::string& value) {
  std::string current;
  size_t start = 0;
  while (start < NormalizeScope(value).size()) {
    const std::string normalized = NormalizeScope(value);
    const size_t end = normalized.find('/', start);
    const size_t length = (end == std::string::npos ? normalized.size() : end) - start;
    const std::string component = normalized.substr(start, length);
    std::set<std::string> children, directories;
    const int result = CollectImmediateChildren(job, current, children, directories);
    if (result < 0) { SetError(job, result, "Repository paths could not be resolved by case."); return value; }
    auto match = std::find_if(children.begin(), children.end(), [&](const auto& child) {
      return ScopeContains(child, component) && ScopeContains(component, child);
    });
    current = JoinScope(current, match == children.end() ? component : *match);
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return current.empty() ? "." : current;
}

void AddPrunedScope(GitStatusJob* job, const std::string& scope, std::vector<std::string>& allowed) {
  if (job->cancelled.load() || job->state->closed.load() || ScopeIsExcluded(scope, job->excludeScopes)) return;
  if (!ScopeHasExcludedDescendant(scope, job->excludeScopes)) {
    allowed.push_back(scope.empty() ? "." : scope);
    return;
  }
  std::set<std::string> children, directories;
  const int result = CollectImmediateChildren(job, scope, children, directories);
  if (result < 0) { SetError(job, result, "The repository paths could not be enumerated while pruning exclusions."); return; }
  for (const auto& child : children) {
    const std::string path = JoinScope(scope, child);
    if (ScopeIsExcluded(path, job->excludeScopes)) continue;
    if (directories.find(child) != directories.end() && ScopeHasExcludedDescendant(path, job->excludeScopes)) AddPrunedScope(job, path, allowed);
    else if (ScopeAllowed(path, job)) allowed.push_back(path);
  }
}

bool BuildPathspecs(GitStatusJob* job) {
  job->scope = CanonicalizeScope(job, job->scope);
  for (auto& include : job->includeScopes) include = CanonicalizeScope(job, include);
  for (auto& exclude : job->excludeScopes) exclude = CanonicalizeScope(job, exclude);
  if (job->result < 0) return false;
  const std::string scope = NormalizeScope(job->scope);
  std::vector<std::string> selected;
  if (job->includeScopes.empty()) selected.push_back(scope);
  else {
    for (const auto& include : job->includeScopes) {
      if (ScopeContains(include, scope)) selected.push_back(scope);
      else if (ScopeContains(scope, include)) selected.push_back(NormalizeScope(include));
    }
  }
  std::sort(selected.begin(), selected.end());
  selected.erase(std::unique(selected.begin(), selected.end()), selected.end());
  std::vector<std::string> roots;
  for (const auto& candidate : selected) {
    if (std::none_of(roots.begin(), roots.end(), [&](const auto& existing) { return ScopeContains(existing, candidate); })) roots.push_back(candidate);
  }
  if (roots.empty()) { job->noSelectedPaths = true; return true; }
  std::vector<std::string> allowed;
  std::set<std::string> children, directories;
  if (!job->recursive || job->include_ignored) {
    const int result = CollectImmediateChildren(job, scope, children, directories);
    if (result < 0) { SetError(job, result, "The direct repository entries could not be enumerated."); return false; }
  }
  if (job->include_ignored) {
    for (const auto& child : directories) {
      if (job->cancelled.load() || job->state->closed.load()) return false;
      const std::string path = JoinScope(scope, child);
      if (!ScopeAllowed(path, job) || ScopeHasExcludedDescendant(path, job->excludeScopes)) continue;
      int ignored = 0;
      const int ignoredResult = git_ignore_path_is_ignored(&ignored, job->repository, path.c_str());
      if (ignoredResult < 0) { SetError(job, ignoredResult, "Ignore rules could not be read."); return false; }
      if (ignored) {
        auto& entry = job->entries[path];
        entry.head = 0; entry.workdir = 0; entry.stage = 0; entry.ignored = true;
      }
    }
  }
  if (!job->recursive) {
    for (const auto& child : children) {
      const std::string path = JoinScope(scope, child);
      if (!ScopeAllowed(path, job)) continue;
      if (directories.find(child) != directories.end()) continue;
      allowed.push_back(path);
    }
  } else {
    for (const auto& root : roots) AddPrunedScope(job, root, allowed);
  }
  if (job->result < 0) return false;
  std::sort(allowed.begin(), allowed.end());
  allowed.erase(std::unique(allowed.begin(), allowed.end()), allowed.end());
  if (allowed.size() == 1 && NormalizeScope(allowed.front()).empty()) return true;
  job->pathspecStorage = std::move(allowed);
  if (job->pathspecStorage.empty()) { job->noSelectedPaths = true; return true; }
  job->pathspecPointers.reserve(job->pathspecStorage.size());
  for (auto& path : job->pathspecStorage) job->pathspecPointers.push_back(path.data());
  return true;
}

bool PathIncluded(const std::string& path, const GitStatusJob* job) {
  if (job->noSelectedPaths) return false;
  if (job->pathspecStorage.empty()) return true;
  return std::any_of(job->pathspecStorage.begin(), job->pathspecStorage.end(), [&](const auto& scope) { return ScopeContains(scope, path); });
}

bool StatMtimeSeconds(const std::filesystem::path& path, int64_t* seconds) {
#ifdef _WIN32
  struct _stat64 info = {};
  if (_wstat64(path.c_str(), &info) != 0) return false;
#else
  struct stat info = {};
  if (::stat(path.c_str(), &info) != 0) return false;
#endif
  *seconds = static_cast<int64_t>(info.st_mtime);
  return true;
}

int HashWorktreeFile(GitStatusJob* job, const std::string& path, git_oid* oid) {
  const auto filename = std::filesystem::u8path(job->root) / std::filesystem::u8path(path);
  const git_index_entry* staged = git_index_get_bypath(job->index, path.c_str(), 0);
  if (!staged) return GIT_ENOTFOUND;
  std::string content;
  if ((staged->mode & 0170000) == 0120000) {
    std::error_code error;
    content = std::filesystem::read_symlink(filename, error).u8string();
    if (error) return GIT_ERROR;
  } else {
    std::ifstream input(filename, std::ios::binary);
    if (!input) return GIT_ERROR;
    std::array<char, 64 * 1024> buffer{};
    while (input) {
      if (job->cancelled.load() || job->state->closed.load()) return GIT_EUSER;
      input.read(buffer.data(), static_cast<std::streamsize>(buffer.size()));
      const auto count = input.gcount();
      if (count > 0) content.append(buffer.data(), static_cast<size_t>(count));
      if (input.bad() || (input.fail() && !input.eof())) return GIT_ERROR;
    }
    if (job->cancelled.load() || job->state->closed.load()) return GIT_EUSER;
    std::string autocrlf = job->autocrlf;
    std::transform(autocrlf.begin(), autocrlf.end(), autocrlf.begin(), [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
    if (autocrlf == "true" || autocrlf == "input") {
      std::string normalized;
      normalized.reserve(content.size());
      for (size_t i = 0; i < content.size(); i++) {
        if (content[i] == '\r' && i + 1 < content.size() && content[i + 1] == '\n') continue;
        normalized.push_back(content[i]);
      }
      content = std::move(normalized);
    }
  }
  return git_odb_hash(oid, content.data(), content.size(), GIT_OBJECT_BLOB);
}

int VerifyCleanEntries(GitStatusJob* job) {
  int64_t indexTime = 0;
  if (!StatMtimeSeconds(std::filesystem::u8path(job->gitdir) / "index", &indexTime)) return 0;
  std::string autocrlf = job->autocrlf;
  std::transform(autocrlf.begin(), autocrlf.end(), autocrlf.begin(), [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
  const bool normalizeCrlf = autocrlf == "true" || autocrlf == "input";
  for (auto& [path, entry] : job->entries) {
    if (job->cancelled.load() || job->state->closed.load()) return GIT_EUSER;
    if (entry.conflicted || entry.ignored) continue;
    const git_index_entry* staged = git_index_get_bypath(job->index, path.c_str(), 0);
    if (!staged || (staged->mode & 0170000) != 0100000) continue;
    const bool autocrlfCandidate = normalizeCrlf && entry.workdir == 2 && entry.stage != 0;
    const bool cacheCollisionCandidate = entry.head == 1 && entry.workdir == 1 && entry.stage == 1 && staged->mtime.seconds >= indexTime;
    if (!autocrlfCandidate && !cacheCollisionCandidate) continue;
    std::error_code fileError;
    if (!std::filesystem::is_regular_file(std::filesystem::symlink_status(std::filesystem::u8path(job->root) / std::filesystem::u8path(path), fileError)) || fileError) continue;
    git_oid oid;
    const int result = HashWorktreeFile(job, path, &oid);
    if (result < 0) return result;
    if (autocrlfCandidate && git_oid_equal(&oid, &staged->id)) entry.workdir = 1;
    else if (cacheCollisionCandidate && !git_oid_equal(&oid, &staged->id)) entry.workdir = 2;
  }
  return 0;
}

int StopAfterDirty(const git_diff*, const git_diff_delta* delta, const char*, void* payload) {
  auto* job = static_cast<GitStatusJob*>(payload);
  if (job->cancelled.load() || job->state->closed.load()) return GIT_EUSER;
  if (delta->status == GIT_DELTA_IGNORED) return 1;
  const char* name = delta->new_file.path ? delta->new_file.path : delta->old_file.path;
  const git_index_entry* staged = name ? git_index_get_bypath(job->index, name, 0) : nullptr;
  if (delta->status == GIT_DELTA_UNMODIFIED) {
    if (job->summaryCheckingWorktree && staged && job->summaryIndexTimeValid && staged->mtime.seconds >= job->summaryIndexTime && (staged->mode & 0170000) == 0100000) {
      git_oid oid;
      const int result = HashWorktreeFile(job, name, &oid);
      if (result < 0) return result;
      if (!git_oid_equal(&oid, &staged->id)) { job->dirty = true; job->dirtyPath = name; return GIT_EUSER; }
    }
    return 1;
  }
  if (job->summaryCheckingWorktree && delta->status == GIT_DELTA_MODIFIED && job->normalizeCrlf && staged && (staged->mode & 0170000) == 0100000) {
    git_oid oid;
    const int result = HashWorktreeFile(job, name, &oid);
    if (result < 0) return result;
    if (git_oid_equal(&oid, &staged->id)) return 1;
  }
  job->dirty = true;
  if (name) job->dirtyPath = name;
  return GIT_EUSER;
}

void ExecuteGitStatusImpl(napi_env, void* data) {
  auto* job = static_cast<GitStatusJob*>(data);
  if (job->cancelled.load() || job->state->closed.load()) return;
  job->result = git_repository_open_ext(&job->repository, job->directory.c_str(), 0, nullptr);
  if (job->result == GIT_ENOTFOUND) {
    job->result = 0;
    return;
  }
  if (job->result < 0) {
    SetError(job, job->result, "The repository could not be opened.");
    return;
  }
  job->repository_found = true;
#ifdef _WIN32
  git_config* pathConfig = nullptr;
  git_config_backend* pathBackend = nullptr;
  static constexpr char pathOptions[] = "[core]\nlongpaths = true\n";
  int pathResult = git_repository_config_snapshot(&pathConfig, job->repository);
  if (pathResult == 0) pathResult = git_config_backend_from_string(&pathBackend, pathOptions, sizeof(pathOptions) - 1, nullptr);
  if (pathResult == 0) {
    pathResult = git_config_add_backend(pathConfig, pathBackend, GIT_CONFIG_LEVEL_APP, job->repository, 0);
    if (pathResult == 0) pathBackend = nullptr;
  }
  if (pathResult == 0) pathResult = git_repository_set_config(job->repository, pathConfig);
  if (pathBackend) pathBackend->free(pathBackend);
  git_config_free(pathConfig);
  if (pathResult < 0) { SetError(job, pathResult, "Long-path support could not be initialized."); return; }
#endif
  const char* workdir = git_repository_workdir(job->repository);
  const char* gitdir = git_repository_path(job->repository);
  job->root = workdir ? workdir : "";
  job->gitdir = gitdir ? gitdir : "";
  git_reference* head_reference = nullptr;
  int head_result = git_repository_head(&head_reference, job->repository);
  if (head_result == GIT_EUNBORNBRANCH) {
    job->unborn = true;
    git_reference* symbolic_head = nullptr;
    if (git_reference_lookup(&symbolic_head, job->repository, "HEAD") == 0) {
      const char* target = git_reference_symbolic_target(symbolic_head);
      if (target && std::strncmp(target, "refs/heads/", 11) == 0) job->branch = target + 11;
      git_reference_free(symbolic_head);
    }
    head_result = 0;
  }
  if (head_result == 0 && head_reference) {
    job->detached = git_repository_head_detached(job->repository) == 1;
    if (!job->detached) {
      const char* name = git_reference_shorthand(head_reference);
      if (name) job->branch = name;
    }
    const git_oid* target = git_reference_target(head_reference);
    if (target) {
      char buffer[GIT_OID_MAX_HEXSIZE + 1] = {};
      git_oid_tostr(buffer, sizeof(buffer), target);
      job->head = buffer;
    }
    if (!job->unborn) {
      git_object* head_object = nullptr;
      const int peel_result = git_reference_peel(&head_object, head_reference, GIT_OBJECT_TREE);
      if (peel_result < 0) { git_reference_free(head_reference); SetError(job, peel_result, "The repository HEAD tree could not be read."); return; }
      job->headTree = reinterpret_cast<git_tree*>(head_object);
    }
  } else if (head_result < 0) {
    if (head_reference) git_reference_free(head_reference);
    SetError(job, head_result, "The repository HEAD could not be read.");
    return;
  }
  if (head_reference) git_reference_free(head_reference);
  if (job->infoOnly) {
    git_branch_iterator* iterator = nullptr;
    int iterator_result = git_branch_iterator_new(&iterator, job->repository, GIT_BRANCH_LOCAL);
    if (iterator_result < 0) { SetError(job, iterator_result, "Local branches could not be read."); return; }
    git_reference* reference = nullptr;
    git_branch_t branchType;
    while ((iterator_result = git_branch_next(&reference, &branchType, iterator)) == 0) {
      const char* name = git_reference_shorthand(reference);
      if (name) job->localBranches.emplace_back(name);
      git_reference_free(reference); reference = nullptr;
    }
    git_branch_iterator_free(iterator);
    if (iterator_result != GIT_ITEROVER) { SetError(job, iterator_result, "Local branches could not be read."); return; }
    git_strarray remotes = {nullptr, 0};
    iterator_result = git_remote_list(&remotes, job->repository);
    if (iterator_result < 0) { SetError(job, iterator_result, "Configured remotes could not be read."); return; }
    std::vector<std::string> configuredRemotes;
    for (size_t i = 0; i < remotes.count; i++) if (remotes.strings[i]) configuredRemotes.emplace_back(remotes.strings[i]);
    git_strarray_dispose(&remotes);
    iterator_result = git_branch_iterator_new(&iterator, job->repository, GIT_BRANCH_REMOTE);
    if (iterator_result < 0) { SetError(job, iterator_result, "Remote branch references could not be read."); return; }
    while ((iterator_result = git_branch_next(&reference, &branchType, iterator)) == 0) {
      const char* name = git_reference_shorthand(reference);
      if (name) {
        for (const auto& remote : configuredRemotes) {
          const std::string prefix = remote + "/";
          if (std::strncmp(name, prefix.c_str(), prefix.size()) == 0 && std::strcmp(name + prefix.size(), "HEAD") != 0) {
            job->remoteBranches.emplace_back(name);
            break;
          }
        }
      }
      git_reference_free(reference); reference = nullptr;
    }
    git_branch_iterator_free(iterator);
    if (iterator_result != GIT_ITEROVER) { SetError(job, iterator_result, "Remote branch references could not be read."); return; }
    std::sort(job->localBranches.begin(), job->localBranches.end());
    std::sort(job->remoteBranches.begin(), job->remoteBranches.end());
    return;
  }
  job->result = git_repository_index(&job->index, job->repository);
  if (job->result < 0) { SetError(job, job->result, "The repository index could not be read."); return; }
  job->indexVersion = git_index_version(job->index);
  for (size_t i = 0; i < git_index_entrycount(job->index); i++) {
    const git_index_entry* entry = git_index_get_byindex(job->index, i);
    if (entry && (entry->flags_extended & GIT_INDEX_ENTRY_SKIP_WORKTREE) != 0) job->skipWorktree = true;
  }
  git_config* config = nullptr;
  job->result = git_repository_config_snapshot(&config, job->repository);
  if (job->result < 0) { SetError(job, job->result, "Repository configuration could not be read."); return; }
  int sparse = 0;
  const int sparseResult = git_config_get_bool(&sparse, config, "core.sparseCheckout");
  if (sparseResult == 0) job->sparseCheckout = sparse != 0;
  else if (sparseResult != GIT_ENOTFOUND) { git_config_free(config); SetError(job, sparseResult, "The sparse-checkout setting is invalid."); return; }
  const char* autocrlf = nullptr;
  const int autocrlfResult = git_config_get_string(&autocrlf, config, "core.autocrlf");
  if (autocrlfResult == 0 && autocrlf) job->autocrlf = autocrlf;
  else if (autocrlfResult != GIT_ENOTFOUND) { git_config_free(config); SetError(job, autocrlfResult, "The autocrlf setting is invalid."); return; }
  git_config_free(config);
  if (job->summary) {
    std::string value = job->autocrlf;
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char item) { return static_cast<char>(std::tolower(item)); });
    job->normalizeCrlf = value == "true" || value == "input";
    job->summaryIndexTimeValid = StatMtimeSeconds(std::filesystem::u8path(job->gitdir) / "index", &job->summaryIndexTime);
    if (job->scope == "." && job->includeScopes.empty() && job->excludeScopes.empty() && git_index_has_conflicts(job->index)) { job->dirty = true; return; }
  }
  if (!BuildPathspecs(job)) return;
  git_diff_options staged{};
  git_diff_options worktree{};
  job->result = git_diff_options_init(&staged, GIT_DIFF_OPTIONS_VERSION);
  if (job->result < 0) { SetError(job, job->result, "The staged diff options could not be initialized."); return; }
  job->result = git_diff_options_init(&worktree, GIT_DIFF_OPTIONS_VERSION);
  if (job->result < 0) { SetError(job, job->result, "The working tree diff options could not be initialized."); return; }
  staged.flags = GIT_DIFF_INCLUDE_UNMODIFIED | GIT_DIFF_DISABLE_PATHSPEC_MATCH;
  staged.progress_cb = CancelOnProgress;
  staged.payload = job;
  worktree.flags = GIT_DIFF_INCLUDE_UNMODIFIED | GIT_DIFF_INCLUDE_UNTRACKED | GIT_DIFF_DISABLE_PATHSPEC_MATCH;
  worktree.flags |= GIT_DIFF_RECURSE_UNTRACKED_DIRS;
  if (job->include_ignored && !job->summary) worktree.flags |= GIT_DIFF_INCLUDE_IGNORED | GIT_DIFF_RECURSE_IGNORED_DIRS;
  if (job->summary) { staged.notify_cb = StopAfterDirty; worktree.notify_cb = StopAfterDirty; }
  worktree.progress_cb = CancelOnProgress;
  worktree.payload = job;
  staged.pathspec.strings = job->pathspecPointers.data();
  staged.pathspec.count = job->pathspecPointers.size();
  worktree.pathspec.strings = job->pathspecPointers.data();
  worktree.pathspec.count = job->pathspecPointers.size();
  if (job->cancelled.load() || job->state->closed.load()) return;
  if (!job->noSelectedPaths) {
    job->result = git_diff_tree_to_index(&job->stagedDiff, job->repository, job->headTree, job->index, &staged);
    if (job->summary && job->dirty && !job->cancelled.load() && !job->state->closed.load()) { job->result = 0; return; }
    if (job->result < 0) { if (!job->cancelled.load()) SetError(job, job->result, "The staged repository changes could not be read."); return; }
    if (job->cancelled.load() || job->state->closed.load()) return;
    job->summaryCheckingWorktree = true;
    job->result = git_diff_index_to_workdir(&job->worktreeDiff, job->repository, job->index, &worktree);
    if (job->summary && job->dirty && !job->cancelled.load() && !job->state->closed.load()) { job->result = 0; return; }
    if (job->result < 0) { if (!job->cancelled.load()) SetError(job, job->result, "The working tree changes could not be read."); return; }
  }
  if (job->summary) return;
  const size_t staged_count = job->stagedDiff ? git_diff_num_deltas(job->stagedDiff) : 0;
  for (size_t i = 0; i < staged_count; i++) {
    const git_diff_delta* delta = git_diff_get_delta(job->stagedDiff, i);
    if (!delta) continue;
    const char* name = delta->new_file.path ? delta->new_file.path : delta->old_file.path;
    if (!name) continue;
    auto& entry = job->entries[name];
    if (delta->status == GIT_DELTA_ADDED || delta->status == GIT_DELTA_COPIED) { entry.head = 0; entry.stage = 2; }
    else if (delta->status == GIT_DELTA_DELETED) { entry.head = 1; entry.stage = 0; }
    else if (delta->status == GIT_DELTA_UNMODIFIED) { entry.head = 1; entry.stage = 1; }
    else { entry.head = 1; entry.stage = 2; }
  }
  const size_t worktree_count = job->worktreeDiff ? git_diff_num_deltas(job->worktreeDiff) : 0;
  for (size_t i = 0; i < worktree_count; i++) {
    const git_diff_delta* delta = git_diff_get_delta(job->worktreeDiff, i);
    if (!delta) continue;
    const char* name = delta->new_file.path ? delta->new_file.path : delta->old_file.path;
    if (!name) continue;
    auto found = job->entries.find(name);
    const bool trackedOrStaged = found != job->entries.end();
    auto& entry = trackedOrStaged ? found->second : job->entries[name];
    if (delta->status == GIT_DELTA_IGNORED) { entry.ignored = true; entry.head = 0; entry.workdir = 0; entry.stage = 0; }
    else if (delta->status == GIT_DELTA_UNTRACKED || delta->status == GIT_DELTA_ADDED) {
      if (!trackedOrStaged) { entry.head = 0; entry.workdir = 2; entry.stage = 0; }
      else entry.workdir = 2;
    } else if (delta->status == GIT_DELTA_DELETED) entry.workdir = 0;
    else if (delta->status == GIT_DELTA_UNMODIFIED) entry.workdir = 1;
    else entry.workdir = 2;
  }
  git_index_conflict_iterator* conflicts = nullptr;
  int conflictResult = git_index_conflict_iterator_new(&conflicts, job->index);
  if (conflictResult < 0) { SetError(job, conflictResult, "Index conflicts could not be read."); return; }
  const git_index_entry *ancestor = nullptr, *ours = nullptr, *theirs = nullptr;
  while ((conflictResult = git_index_conflict_next(&ancestor, &ours, &theirs, conflicts)) == 0) {
    if (job->cancelled.load() || job->state->closed.load()) { git_index_conflict_iterator_free(conflicts); return; }
    const char* name = ours ? ours->path : theirs ? theirs->path : ancestor ? ancestor->path : nullptr;
    if (name && PathIncluded(name, job)) job->entries[name].conflicted = true;
    ancestor = nullptr; ours = nullptr; theirs = nullptr;
  }
  git_index_conflict_iterator_free(conflicts);
  if (conflictResult != GIT_ITEROVER) { SetError(job, conflictResult, "Index conflicts could not be read."); return; }
  const int verifyResult = VerifyCleanEntries(job);
  if (verifyResult < 0 && !job->cancelled.load() && !job->state->closed.load()) SetError(job, verifyResult, "Clean file contents could not be verified.");
}

void ExecuteGitStatus(napi_env env, void* data) {
  auto* job = static_cast<GitStatusJob*>(data);
  try { ExecuteGitStatusImpl(env, data); }
  catch (const std::bad_alloc&) { job->result = GIT_ERROR; job->code = "ResourceExhausted"; job->message = "Git status resources could not be allocated."; }
  catch (const std::exception&) { job->result = GIT_ERROR; job->code = "GitFailure"; job->message = "Git status could not be completed."; }
}

napi_value GitStatusResult(napi_env env, GitStatusJob* job) {
  napi_value result, entries;
  if (napi_create_object(env, &result) != napi_ok || napi_create_array_with_length(env, job->entries.size(), &entries) != napi_ok) return nullptr;
  if (!Set(env, result, "ok", Boolean(env, true)) || !Set(env, result, "repository", Boolean(env, job->repository_found)) || !Set(env, result, "entries", entries)) return nullptr;
  if (!job->repository_found) return result;
  if (!Set(env, result, "root", String(env, job->root)) || !Set(env, result, "gitdir", String(env, job->gitdir)) ||
      !Set(env, result, "branch", job->branch.empty() ? Boolean(env, false) : String(env, job->branch)) ||
      !Set(env, result, "detached", Boolean(env, job->detached)) || !Set(env, result, "unborn", Boolean(env, job->unborn))) return nullptr;
  if (!job->head.empty() && !Set(env, result, "head", String(env, job->head))) return nullptr;
  if (job->infoOnly) {
    napi_value names, remotes;
    if (napi_create_array_with_length(env, job->localBranches.size(), &names) != napi_ok || napi_create_array_with_length(env, job->remoteBranches.size(), &remotes) != napi_ok) return nullptr;
    for (uint32_t i = 0; i < job->localBranches.size(); i++) if (napi_set_element(env, names, i, String(env, job->localBranches[i])) != napi_ok) return nullptr;
    for (uint32_t i = 0; i < job->remoteBranches.size(); i++) if (napi_set_element(env, remotes, i, String(env, job->remoteBranches[i])) != napi_ok) return nullptr;
    if (!Set(env, result, "names", names) || !Set(env, result, "remoteNames", remotes) ||
        !Set(env, result, "count", Number(env, static_cast<uint32_t>(job->localBranches.size())))) return nullptr;
    const size_t current = std::find(job->localBranches.begin(), job->localBranches.end(), job->branch) != job->localBranches.end() ? 1 : 0;
    if (!Set(env, result, "otherCount", Number(env, static_cast<uint32_t>(job->localBranches.size() - current)))) return nullptr;
    return result;
  }
  if (!Set(env, result, "indexVersion", Number(env, static_cast<uint32_t>(job->indexVersion))) ||
      !Set(env, result, "skipWorktree", Boolean(env, job->skipWorktree)) ||
      !Set(env, result, "sparseCheckout", Boolean(env, job->sparseCheckout)) ||
      !Set(env, result, "autocrlf", String(env, job->autocrlf))) return nullptr;
  uint32_t index = 0;
  if (job->summary && (!Set(env, result, "summary", Boolean(env, true)) || !Set(env, result, "dirty", Boolean(env, job->dirty)))) return nullptr;
  if (job->summary && !job->dirtyPath.empty() && !Set(env, result, "dirtyPath", String(env, job->dirtyPath))) return nullptr;
  for (const auto& [name, source] : job->entries) {
    napi_value entry;
    if (napi_create_object(env, &entry) != napi_ok) return nullptr;
    if (!Set(env, entry, "path", String(env, name)) || !Set(env, entry, "head", Number(env, static_cast<uint32_t>(source.head))) ||
        !Set(env, entry, "workdir", Number(env, static_cast<uint32_t>(source.workdir))) || !Set(env, entry, "stage", Number(env, static_cast<uint32_t>(source.stage))) ||
        !Set(env, entry, "flags", Number(env, source.conflicted ? 1 : (source.head != 1 || source.workdir != 1 || source.stage != 1) ? 1 : 0)) ||
        !Set(env, entry, "conflicted", Boolean(env, source.conflicted)) || !Set(env, entry, "ignored", Boolean(env, source.ignored)) ||
        napi_set_element(env, entries, index++, entry) != napi_ok) return nullptr;
  }
  return result;
}

void RetireGitStatusJob(GitStatusJob* job);

void CompleteGitStatus(napi_env env, napi_status status, void* data) {
  auto* job = static_cast<GitStatusJob*>(data);
  const bool closed = job->state->closed.load();
  const bool cancelled = job->cancelled.load() || status != napi_ok;
  napi_value success = nullptr;
  if (!closed && !cancelled && job->result >= 0) success = GitStatusResult(env, job);
  if (job->worktreeDiff) git_diff_free(job->worktreeDiff);
  if (job->stagedDiff) git_diff_free(job->stagedDiff);
  if (job->headTree) git_tree_free(job->headTree);
  if (job->index) git_index_free(job->index);
  if (job->repository) git_repository_free(job->repository);
  if (job->work) napi_delete_async_work(env, job->work);
  if (job->progress) {
    napi_release_threadsafe_function(job->progress, napi_tsfn_release);
    job->progress = nullptr;
  }
  RetireGitStatusJob(job);
  if (closed) {
    Reject(env, job->deferred, "SessionClosed", "The native session is closed.");
  } else if (job->progressState && job->progressState->allocationFailed.load()) {
    Reject(env, job->deferred, "ResourceExhausted", "Git progress resources could not be allocated.");
  } else if (job->progressState && job->progressState->callbackFailed.load()) {
    Reject(env, job->deferred, "ProgressCallbackFailed", "The Git progress callback failed.");
  } else if (cancelled) {
    Reject(env, job->deferred, "Cancelled", "The Git status request was cancelled.");
  } else if (job->result < 0) {
    Reject(env, job->deferred, job->code.empty() ? "GitFailure" : job->code.c_str(), job->message.empty() ? "The Git status request failed." : job->message.c_str());
  } else {
    if (success) napi_resolve_deferred(env, job->deferred, success);
    else Reject(env, job->deferred, "BindingFailure", "The Git status result could not be created.");
  }
  if (job->promise) napi_delete_reference(env, job->promise);
}

napi_value CancelGitStatus(napi_env env, napi_callback_info info) {
  size_t count = 0;
  napi_value receiver = nullptr;
  void* data = nullptr;
  if (napi_get_cb_info(env, info, &count, nullptr, &receiver, &data) != napi_ok || !receiver) {
    napi_throw_error(env, "InvalidRequest", "The cancellation function must be called on its Git status promise.");
    return nullptr;
  }
  bool isStatusPromise = false;
  if (napi_check_object_type_tag(env, receiver, &kGitStatusPromiseTag, &isStatusPromise) != napi_ok || !isStatusPromise) {
    napi_throw_error(env, "InvalidRequest", "The cancellation function must be called on its Git status promise.");
    return nullptr;
  }
  void* wrapped = nullptr;
  if (napi_unwrap(env, receiver, &wrapped) != napi_ok || !wrapped) {
    napi_throw_error(env, "InvalidRequest", "The cancellation function must be called on its Git status promise.");
    return nullptr;
  }
  auto* job = static_cast<GitStatusJob*>(wrapped);
  const bool changed = !job->cancelled.exchange(true);
  napi_value result;
  if (napi_get_boolean(env, changed, &result) != napi_ok) return nullptr;
  return result;
}

void FinalizeGitStatus(napi_env, void* data, void*) {
  delete static_cast<GitStatusJob*>(data);
}

void RetireGitStatusJob(GitStatusJob* job) {
  auto* runtime = job->runtime;
  if (!runtime) return;
  bool shutdown = false;
  {
    std::lock_guard<std::mutex> lock(runtime->mutex);
    runtime->active.erase(job);
    shutdown = runtime->closing && runtime->active.empty();
  }
  job->runtime = nullptr;
  if (shutdown) {
    if (runtime->initialized) git_libgit2_shutdown();
    delete runtime;
  }
}

void ShutdownGitStatus(void* data) {
  auto* runtime = static_cast<GitStatusRuntime*>(data);
  bool shutdown = false;
  {
    std::lock_guard<std::mutex> lock(runtime->mutex);
    runtime->closing = true;
    for (auto* job : runtime->active) job->cancelled.store(true);
    shutdown = runtime->active.empty();
  }
  if (shutdown) {
    if (runtime->initialized) git_libgit2_shutdown();
    delete runtime;
  }
}
}

bool IsGitStatusOperation(const char* operation) {
  return std::strcmp(operation, "git.status") == 0;
}

void InitializeGitStatus(napi_env env) {
  if (git_libgit2_init() < 0) {
    napi_throw_error(env, "GitInitializationFailed", "The Git runtime could not be initialized.");
    return;
  }
  auto* runtime = new (std::nothrow) GitStatusRuntime;
  if (!runtime) {
    git_libgit2_shutdown();
    napi_throw_error(env, "ResourceExhausted", "The Git runtime could not be allocated.");
    return;
  }
  runtime->initialized = true;
  if (napi_set_instance_data(env, runtime, nullptr, nullptr) != napi_ok) {
    git_libgit2_shutdown();
    delete runtime;
    napi_throw_error(env, "BindingFailure", "The Git runtime could not be retained.");
    return;
  }
  if (napi_add_env_cleanup_hook(env, ShutdownGitStatus, runtime) != napi_ok) {
    napi_set_instance_data(env, nullptr, nullptr, nullptr);
    git_libgit2_shutdown();
    delete runtime;
    napi_throw_error(env, "BindingFailure", "The Git runtime cleanup hook could not be registered.");
  }
}

napi_value StartGitRequest(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request, napi_value progressCallback, bool infoOnly) {
  napi_valuetype type;
  if (napi_typeof(env, request, &type) != napi_ok || type != napi_object || request == nullptr) {
    napi_throw_error(env, "InvalidRequest", "A Git status request is required.");
    return nullptr;
  }
  auto job = std::make_unique<GitStatusJob>();
  job->state = state;
  job->infoOnly = infoOnly;
  void* runtimeData = nullptr;
  if (napi_get_instance_data(env, &runtimeData) != napi_ok || !runtimeData) {
    napi_throw_error(env, "BindingFailure", "The Git runtime is unavailable.");
    return nullptr;
  }
  job->runtime = static_cast<GitStatusRuntime*>(runtimeData);
  if (!ReadString(env, request, "directory", job->directory) || job->directory.empty() || (!infoOnly && !ReadString(env, request, "scope", job->scope))) {
    napi_throw_error(env, "InvalidRequest", "An absolute directory and a repository-relative scope are required.");
    return nullptr;
  }
  const auto directory = std::filesystem::u8path(job->directory);
  if (job->directory.find('\0') != std::string::npos || !directory.is_absolute() ||
      std::any_of(directory.begin(), directory.end(), [](const auto& part) { return part == std::filesystem::path(".."); }) ||
      (!infoOnly && !ValidRelativeScope(job->scope, true))) {
    napi_throw_error(env, "InvalidRequest", "The directory or repository-relative scope is invalid.");
    return nullptr;
  }
  if (!infoOnly && (!ReadStringArray(env, request, "includeScopes", job->includeScopes) || !ReadStringArray(env, request, "excludeScopes", job->excludeScopes))) {
    napi_throw_error(env, "InvalidRequest", "Include and exclude scopes must be arrays of repository-relative paths.");
    return nullptr;
  }
  if (!ValidBoolean(env, request, "recursive") || !ValidBoolean(env, request, "showIgnored")) {
    napi_throw_error(env, "InvalidRequest", "Boolean status options must be boolean values.");
    return nullptr;
  }
  job->include_ignored = !infoOnly && ReadBoolean(env, request, "showIgnored", false);
  if (!infoOnly && !ValidBoolean(env, request, "summary")) { napi_throw_error(env, "InvalidRequest", "The summary option must be a boolean."); return nullptr; }
  job->summary = !infoOnly && ReadBoolean(env, request, "summary", false);
  if (job->summary) job->include_ignored = false;
  job->recursive = infoOnly || ReadBoolean(env, request, "recursive", true);
  napi_value promise;
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok) return nullptr;
  napi_value resource = String(env, "git.status");
  if (!infoOnly) {
    napi_valuetype progressType;
    if (napi_typeof(env, progressCallback, &progressType) != napi_ok || (progressType != napi_undefined && progressType != napi_function)) {
      napi_throw_error(env, "InvalidRequest", "The Git progress handler must be a function.");
      return nullptr;
    }
    if (progressType == napi_function) job->progressState = std::make_shared<GitStatusProgressState>();
    if (progressType == napi_function && napi_create_threadsafe_function(env, progressCallback, nullptr, resource, 64, 1, nullptr, nullptr, nullptr, CallStatusProgress, &job->progress) != napi_ok) {
      napi_throw_error(env, "BindingFailure", "Cannot create Git progress delivery.");
      return nullptr;
    }
  }
  if (napi_create_async_work(env, nullptr, resource, ExecuteGitStatus, CompleteGitStatus, job.get(), &job->work) != napi_ok) {
    if (job->progress) napi_release_threadsafe_function(job->progress, napi_tsfn_abort);
    napi_throw_error(env, "BindingFailure", "Cannot create Git status work.");
    return nullptr;
  }
  job->promise = nullptr;
  if (napi_create_reference(env, promise, 1, &job->promise) != napi_ok) {
    napi_delete_async_work(env, job->work);
    if (job->progress) napi_release_threadsafe_function(job->progress, napi_tsfn_abort);
    napi_throw_error(env, "BindingFailure", "Cannot retain Git status work.");
    return nullptr;
  }
  GitStatusJob* rawJob = job.release();
  if (napi_wrap(env, promise, rawJob, FinalizeGitStatus, nullptr, nullptr) != napi_ok) {
    napi_delete_reference(env, rawJob->promise);
    napi_delete_async_work(env, rawJob->work);
    if (rawJob->progress) napi_release_threadsafe_function(rawJob->progress, napi_tsfn_abort);
    delete rawJob;
    napi_throw_error(env, "BindingFailure", "Cannot retain Git status work.");
    return nullptr;
  }
  if (napi_type_tag_object(env, promise, &kGitStatusPromiseTag) != napi_ok) {
    napi_delete_reference(env, rawJob->promise);
    napi_delete_async_work(env, rawJob->work);
    if (rawJob->progress) napi_release_threadsafe_function(rawJob->progress, napi_tsfn_abort);
    void* removed = nullptr;
    napi_remove_wrap(env, promise, &removed);
    delete rawJob;
    napi_throw_error(env, "BindingFailure", "Cannot mark Git status cancellation target.");
    return nullptr;
  }
  napi_property_descriptor cancel = {"cancel", nullptr, CancelGitStatus, nullptr, nullptr, nullptr, napi_default, rawJob};
  if (napi_define_properties(env, promise, 1, &cancel) != napi_ok) {
    rawJob->cancelled.store(true);
    napi_delete_async_work(env, rawJob->work);
    napi_delete_reference(env, rawJob->promise);
    if (rawJob->progress) napi_release_threadsafe_function(rawJob->progress, napi_tsfn_abort);
    void* removed = nullptr;
    napi_remove_wrap(env, promise, &removed);
    delete rawJob;
    napi_throw_error(env, "BindingFailure", "Cannot bind Git status cancellation.");
    return nullptr;
  }
  bool closing = false;
  {
    std::lock_guard<std::mutex> lock(rawJob->runtime->mutex);
    closing = rawJob->runtime->closing;
    if (!closing) rawJob->runtime->active.insert(rawJob);
  }
  if (closing || napi_queue_async_work(env, rawJob->work) != napi_ok) {
    rawJob->cancelled.store(true);
    if (!closing) RetireGitStatusJob(rawJob);
    napi_delete_async_work(env, rawJob->work);
    napi_delete_reference(env, rawJob->promise);
    if (rawJob->progress) napi_release_threadsafe_function(rawJob->progress, napi_tsfn_abort);
    void* removed = nullptr;
    napi_remove_wrap(env, promise, &removed);
    delete rawJob;
    napi_throw_error(env, "BindingFailure", "Cannot queue Git status work.");
    return nullptr;
  }
  return promise;
}

napi_value StartGitStatus(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request, napi_value progress) {
  return StartGitRequest(env, state, request, progress, false);
}

napi_value StartGitInfo(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request) {
  napi_value progress;
  if (napi_get_undefined(env, &progress) != napi_ok) return nullptr;
  return StartGitRequest(env, state, request, progress, true);
}

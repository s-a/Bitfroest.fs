#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <algorithm>
#include <cstddef>
#include <cstring>
#include <memory>
#include <string>
#include <vector>
#include "windows-rename.h"
#include "windows-async-work.h"

namespace {
struct NativeError { const char* code; DWORD number; };
struct Handle {
  HANDLE value;
  explicit Handle(HANDLE input) : value(input) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(other.value) { other.value = INVALID_HANDLE_VALUE; }
};
struct Job {
  std::shared_ptr<SessionState> state;
  std::wstring source, target;
  std::string dev, ino, size, mtime, ctime;
  napi_deferred deferred = nullptr;
  const char* error = nullptr;
  DWORD native_error = 0;
  bool committed = false;
};
napi_value Fail(napi_env env, const char* code, const char* message) { napi_throw_error(env, code, message); return nullptr; }
#define CHECK(call) do { if ((call) != napi_ok) return Fail(env, "BindingFailure", "Native rename binding failed."); } while (false)
napi_value Text(napi_env env, const char* text) {
  napi_value result;
  CHECK(napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &result));
  return result;
}
bool String(napi_env env, napi_value object, const char* key, std::wstring* output) {
  napi_value value;
  napi_valuetype type;
  napi_value null_value;
  bool is_null;
  size_t length;
  if (napi_typeof(env, object, &type) != napi_ok || type != napi_object || napi_get_null(env, &null_value) != napi_ok || napi_strict_equals(env, object, null_value, &is_null) != napi_ok || is_null) return false;
  if (napi_get_named_property(env, object, key, &value) != napi_ok || napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || length > 32767) return false;
  std::vector<char16_t> buffer(length + 1);
  if (napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
  output->assign(buffer.begin(), buffer.begin() + length);
  return output->find(L'\0') == std::wstring::npos;
}
bool Equal(const std::wstring& left, const std::wstring& right) {
  return CompareStringOrdinal(left.c_str(), static_cast<int>(left.size()), right.c_str(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}
size_t RootLength(const std::wstring& path) {
  if (path.size() >= 3 && ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) && path[1] == L':' && path[2] == L'\\') return 3;
  if (path.size() > 4 && path.substr(0, 2) == L"\\\\" && path[2] != L'.' && path[2] != L'?') {
    const auto server = path.find(L'\\', 2);
    if (server == std::wstring::npos || server == 2 || server + 1 == path.size()) return 0;
    const auto share = path.find(L'\\', server + 1);
    return share == std::wstring::npos ? path.size() : share + 1;
  }
  return 0;
}
bool Clean(std::wstring* path) {
  std::replace(path->begin(), path->end(), L'/', L'\\');
  if (path->substr(0, 8) == L"\\\\?\\UNC\\") *path = L"\\\\" + path->substr(8);
  else if (path->substr(0, 4) == L"\\\\?\\") *path = path->substr(4);
  const size_t root = RootLength(*path);
  if (!root || path->find(L':', root) != std::wstring::npos) return false;
  for (size_t start = root; start <= path->size();) {
    const auto end = path->find(L'\\', start);
    if (path->substr(start, end - start) == L"..") return false;
    if (end == std::wstring::npos) break;
    start = end + 1;
  }
  const DWORD count = GetFullPathNameW(path->c_str(), 0, nullptr, nullptr);
  if (!count || count > 32767) return false;
  std::vector<wchar_t> buffer(count);
  const DWORD written = GetFullPathNameW(path->c_str(), count, buffer.data(), nullptr);
  if (!written || written >= count) return false;
  path->assign(buffer.data(), written);
  while (path->size() > RootLength(*path) && path->back() == L'\\') path->pop_back();
  return true;
}
std::wstring Extended(const std::wstring& path) { return path.substr(0, 2) == L"\\\\" ? L"\\\\?\\UNC\\" + path.substr(2) : L"\\\\?\\" + path; }
void WinError() {
  const DWORD error = GetLastError();
  throw NativeError{error == ERROR_ACCESS_DENIED ? "Denied" : error == ERROR_SHARING_VIOLATION ? "Busy" : error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS ? "AlreadyExists" : error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? "NotFound" : "NativeFailure", error};
}
Handle Open(const std::wstring& path, DWORD access, DWORD share) {
  Handle handle(CreateFileW(Extended(path).c_str(), access, share, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (handle.value == INVALID_HANDLE_VALUE) WinError();
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(handle.value, &info)) WinError();
  if (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) throw NativeError{"ReparsePoint", 0};
  return handle;
}
uint64_t Pair(DWORD high, DWORD low) { return (static_cast<uint64_t>(high) << 32) | low; }
std::string Nanoseconds(int64_t ticks) {
  constexpr int64_t epoch = 116444736000000000LL;
  if (ticks == epoch) return "0";
  if (ticks > epoch) return std::to_string(static_cast<uint64_t>(ticks) - epoch) + "00";
  const uint64_t magnitude = ticks >= 0 ? static_cast<uint64_t>(epoch - ticks) : static_cast<uint64_t>(epoch) + static_cast<uint64_t>(-(ticks + 1)) + 1;
  return "-" + std::to_string(magnitude) + "00";
}
void Execute(napi_env, void* data) {
  auto* job = static_cast<Job*>(data);
  try {
    if (job->state->closed) throw NativeError{"SessionClosed", 0};
    const auto parent = job->source.substr(0, job->source.find_last_of(L'\\'));
    const size_t root = RootLength(job->source);
    std::vector<Handle> parents;
    parents.push_back(Open(job->source.substr(0, root), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE));
    for (size_t end = root; end <= parent.size(); ++end) {
      if (end == parent.size() || parent[end] == L'\\') {
        parents.push_back(Open(parent.substr(0, end), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE));
      }
    }
    auto source = Open(job->source, DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ);
    BY_HANDLE_FILE_INFORMATION info{};
    FILE_BASIC_INFO basic{};
    if (!GetFileInformationByHandle(source.value, &info) || !GetFileInformationByHandleEx(source.value, FileBasicInfo, &basic, sizeof(basic))) WinError();
    if (std::to_string(info.dwVolumeSerialNumber) != job->dev || std::to_string(Pair(info.nFileIndexHigh, info.nFileIndexLow)) != job->ino ||
        std::to_string(Pair(info.nFileSizeHigh, info.nFileSizeLow)) != job->size || Nanoseconds(basic.LastWriteTime.QuadPart) != job->mtime || Nanoseconds(basic.ChangeTime.QuadPart) != job->ctime) throw NativeError{"IdentityChanged", 0};
    const auto target = Extended(job->target);
    const size_t count = offsetof(FILE_RENAME_INFO, FileName) + (target.size() + 1) * sizeof(wchar_t);
    std::vector<unsigned char> buffer(count, 0);
    auto* rename = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
    rename->ReplaceIfExists = FALSE;
    rename->FileNameLength = static_cast<DWORD>(target.size() * sizeof(wchar_t));
    std::memcpy(rename->FileName, target.data(), rename->FileNameLength);
    if (job->state->closed) throw NativeError{"SessionClosed", 0};
    if (!SetFileInformationByHandle(source.value, FileRenameInfo, buffer.data(), static_cast<DWORD>(count))) WinError();
    job->committed = true;
  } catch (const NativeError& error) { job->error = error.code; job->native_error = error.number; }
    catch (const std::bad_alloc&) { job->error = "ResourceExhausted"; }
    catch (...) { job->error = "NativeFailure"; }
}
napi_value Outcome(napi_env env, bool committed) {
  napi_value result, renamed;
  CHECK(napi_create_object(env, &result));
  CHECK(napi_get_boolean(env, committed, &renamed));
  CHECK(napi_set_named_property(env, result, "renamed", renamed));
  CHECK(napi_set_named_property(env, result, "status", Text(env, committed ? "committed" : "unchanged")));
  return result;
}
void Complete(napi_env env, napi_status status, void* data) {
  auto* job = static_cast<Job*>(data);
  const char* code = job->state->closed ? "SessionClosed" : status != napi_ok ? "Cancelled" : job->error;
  napi_value outcome = Outcome(env, job->committed);
  if (!outcome) return;
  if (code) {
    napi_value error, number;
    if (napi_create_error(env, Text(env, code), Text(env, "Native rename failed."), &error) != napi_ok) return;
    napi_create_uint32(env, job->native_error, &number);
    napi_set_named_property(env, error, "nativeCode", number);
    napi_set_named_property(env, error, "operation", Text(env, "files.rename"));
    napi_set_named_property(env, error, "outcome", outcome);
    napi_reject_deferred(env, job->deferred, error);
  } else napi_resolve_deferred(env, job->deferred, outcome);
}
}

napi_value StartCaseRename(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request) {
  auto job = std::make_unique<Job>();
  job->state = state;
  if (!String(env, request, "source", &job->source) || !String(env, request, "target", &job->target) || !Clean(&job->source) || !Clean(&job->target) ||
      job->source == job->target || !Equal(job->source, job->target) || !Equal(job->source.substr(0, job->source.find_last_of(L'\\')), job->target.substr(0, job->target.find_last_of(L'\\')))) return Fail(env, "InvalidRequest", "Only an absolute case change in the same directory is supported.");
  napi_value roots, expected;
  bool array = false, allowed = false;
  uint32_t length;
  if (napi_get_named_property(env, request, "roots", &roots) != napi_ok || napi_is_array(env, roots, &array) != napi_ok || !array || napi_get_array_length(env, roots, &length) != napi_ok || !length) return Fail(env, "InvalidRequest", "Allowed roots are required.");
  for (uint32_t i = 0; i < length; ++i) {
    napi_value root_value, object;
    CHECK(napi_get_element(env, roots, i, &root_value));
    CHECK(napi_create_object(env, &object));
    CHECK(napi_set_named_property(env, object, "path", root_value));
    std::wstring root;
    if (!String(env, object, "path", &root) || !Clean(&root)) return Fail(env, "InvalidRequest", "An absolute allowed root is required.");
    if (root.back() != L'\\') root += L'\\';
    if (job->source.size() > root.size() && Equal(job->source.substr(0, root.size()), root)) allowed = true;
  }
  if (!allowed || napi_get_named_property(env, request, "expected", &expected) != napi_ok) return Fail(env, "InvalidRequest", "A scoped source and complete expected identity are required.");
  struct Field { const char* name; std::string* output; bool negative; };
  const Field fields[] = {{"dev", &job->dev, false}, {"ino", &job->ino, false}, {"size", &job->size, false}, {"mtimeNs", &job->mtime, true}, {"ctimeNs", &job->ctime, true}};
  for (const auto& field : fields) {
    std::wstring value;
    if (!String(env, expected, field.name, &value) || value.empty() || value.size() > 24) return Fail(env, "InvalidRequest", "A complete decimal identity is required.");
    const size_t start = field.negative && value[0] == L'-' ? 1 : 0;
    if (start == value.size() || !std::all_of(value.begin() + start, value.end(), [](wchar_t c) { return c >= L'0' && c <= L'9'; })) return Fail(env, "InvalidRequest", "A complete decimal identity is required.");
    for (wchar_t digit : value) field.output->push_back(static_cast<char>(digit));
  }
  napi_value promise;
  CHECK(napi_create_promise(env, &job->deferred, &promise));
  if (QueueWindowsWork(env, "files.rename", std::move(job), Execute, Complete) != napi_ok) return Fail(env, "BindingFailure", "Cannot queue native rename.");
  return promise;
}

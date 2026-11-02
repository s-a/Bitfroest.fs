#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <node_api.h>
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include "directory-win.h"
#include "windows-async-work.h"

namespace {
struct Entry {
  std::wstring name, dos_name;
  DWORD attributes = 0;
  uint64_t id = 0;
  int64_t size = 0, creation = 0, access = 0, write = 0, change = 0;
};
struct Job {
  std::shared_ptr<SessionState> state;
  std::shared_ptr<std::atomic<bool>> cancelled = std::make_shared<std::atomic<bool>>(false);
  std::wstring path;
  std::vector<Entry> entries;
  uint64_t volume = 0, directory_id = 0;
  uint32_t batches = 0;
  DWORD error = ERROR_SUCCESS;
  const char* code = nullptr;
  napi_deferred deferred = nullptr;
};
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
napi_value Fail(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message); return nullptr;
}
#define CHECK(call) do { if ((call) != napi_ok) return Fail(env, "BindingFailure", "Directory result conversion failed."); } while (false)
napi_value Text(napi_env env, const char* text) {
  napi_value value; CHECK(napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value)); return value;
}
bool Parse(napi_env env, napi_value request, std::wstring* path) {
  napi_value value; size_t length = 0;
  napi_valuetype type; bool array = false, is_null = false;
  napi_value null_value;
  if (napi_typeof(env, request, &type) != napi_ok || type != napi_object ||
      napi_is_array(env, request, &array) != napi_ok || array ||
      napi_get_null(env, &null_value) != napi_ok ||
      napi_strict_equals(env, request, null_value, &is_null) != napi_ok || is_null) return false;
  if (napi_get_named_property(env, request, "path", &value) != napi_ok ||
      napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || !length || length > 32760) return false;
  std::vector<char16_t> buffer(length + 1);
  if (napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
  path->assign(buffer.begin(), buffer.begin() + length);
  if (path->find(L'\0') != std::wstring::npos) return false;
  std::replace(path->begin(), path->end(), L'/', L'\\');
  const bool drive = length >= 3 && (((*path)[0] >= L'A' && (*path)[0] <= L'Z') || ((*path)[0] >= L'a' && (*path)[0] <= L'z')) && (*path)[1] == L':' && (*path)[2] == L'\\';
  const bool unc = length >= 5 && path->rfind(L"\\\\", 0) == 0 && (*path)[2] != L'?' && (*path)[2] != L'.';
  if (!drive && !unc) return false;
  if (path->find(L':', drive ? 2 : 0) != std::wstring::npos) return false;
  for (size_t start = drive ? 3 : 2; start < path->size();) {
    const size_t end = path->find(L'\\', start);
    const auto part = path->substr(start, end == std::wstring::npos ? end : end - start);
    if (part == L"." || part == L"..") return false;
    if (end == std::wstring::npos) break;
    start = end + 1;
  }
  *path = drive ? L"\\\\?\\" + *path : L"\\\\?\\UNC\\" + path->substr(2);
  return true;
}
bool Stop(Job* job) {
  if (job->state->closed) job->code = "SessionClosed";
  else if (job->cancelled->load()) job->code = "Cancelled";
  return job->code != nullptr;
}
void Execute(napi_env, void* data) {
  auto* job = static_cast<Job*>(data);
  try {
    if (Stop(job)) return;
    Handle handle;
    handle.value = CreateFileW(job->path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (handle.value == INVALID_HANDLE_VALUE) { job->error = GetLastError(); return; }
    BY_HANDLE_FILE_INFORMATION directory{};
    if (!GetFileInformationByHandle(handle.value, &directory)) { job->error = GetLastError(); return; }
    if (!(directory.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (directory.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
      job->code = "InvalidDirectory"; return;
    }
    job->volume = directory.dwVolumeSerialNumber;
    job->directory_id = (static_cast<uint64_t>(directory.nFileIndexHigh) << 32) | directory.nFileIndexLow;
    std::vector<uint64_t> buffer(8192);
    bool first = true;
    while (!Stop(job)) {
      if (!GetFileInformationByHandleEx(handle.value, first ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
          buffer.data(), static_cast<DWORD>(buffer.size() * sizeof(uint64_t)))) {
        const DWORD error = GetLastError();
        if (error != ERROR_NO_MORE_FILES) job->error = error;
        return;
      }
      first = false; ++job->batches;
      size_t offset = 0;
      while (!Stop(job)) {
        const size_t remaining = buffer.size() * sizeof(uint64_t) - offset;
        if (remaining < offsetof(FILE_ID_BOTH_DIR_INFO, FileName)) { job->code = "InvalidResponse"; return; }
        const auto* info = reinterpret_cast<const FILE_ID_BOTH_DIR_INFO*>(reinterpret_cast<const char*>(buffer.data()) + offset);
        if (info->FileNameLength % sizeof(wchar_t) || info->FileNameLength > remaining - offsetof(FILE_ID_BOTH_DIR_INFO, FileName) ||
            info->ShortNameLength < 0 || static_cast<size_t>(info->ShortNameLength) > sizeof(info->ShortName) || info->ShortNameLength % sizeof(wchar_t)) {
          job->code = "InvalidResponse"; return;
        }
        Entry entry;
        entry.name.assign(info->FileName, info->FileNameLength / sizeof(wchar_t));
        if (entry.name != L"." && entry.name != L"..") {
          if (entry.name.empty() || entry.name.find_first_of(L"\\/:") != std::wstring::npos || entry.name.find(L'\0') != std::wstring::npos) { job->code = "InvalidResponse"; return; }
          entry.dos_name.assign(info->ShortName, static_cast<size_t>(info->ShortNameLength) / sizeof(wchar_t));
          if (entry.dos_name.empty()) {
            BOOL legal = FALSE, spaces = FALSE;
            if (CheckNameLegalDOS8Dot3W(entry.name.c_str(), nullptr, 0, &spaces, &legal) && legal && !spaces) entry.dos_name = entry.name;
          }
          entry.attributes = info->FileAttributes; entry.id = static_cast<uint64_t>(info->FileId.QuadPart);
          entry.size = info->EndOfFile.QuadPart; entry.creation = info->CreationTime.QuadPart;
          entry.access = info->LastAccessTime.QuadPart; entry.write = info->LastWriteTime.QuadPart; entry.change = info->ChangeTime.QuadPart;
          job->entries.push_back(std::move(entry));
        }
        if (!info->NextEntryOffset) break;
        if (info->NextEntryOffset % 8 || info->NextEntryOffset < offsetof(FILE_ID_BOTH_DIR_INFO, FileName) + info->FileNameLength || info->NextEntryOffset >= remaining) {
          job->code = "InvalidResponse"; return;
        }
        offset += info->NextEntryOffset;
      }
    }
  } catch (const std::bad_alloc&) { job->code = "ResourceExhausted"; }
    catch (...) { job->code = "NativeFailure"; }
}
napi_value Result(napi_env env, Job* job) {
  napi_value result, rows, value; CHECK(napi_create_object(env, &result));
  CHECK(napi_create_array_with_length(env, job->entries.size(), &rows));
  for (size_t index = 0; index < job->entries.size(); ++index) {
    const auto& entry = job->entries[index]; napi_value row;
    CHECK(napi_create_object(env, &row));
    CHECK(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(entry.name.data()), entry.name.size(), &value));
    CHECK(napi_set_named_property(env, row, "name", value));
    CHECK(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(entry.dos_name.data()), entry.dos_name.size(), &value));
    CHECK(napi_set_named_property(env, row, "dosName", value));
    CHECK(napi_create_uint32(env, entry.attributes, &value)); CHECK(napi_set_named_property(env, row, "attributes", value));
    CHECK(napi_create_bigint_uint64(env, entry.id, &value)); CHECK(napi_set_named_property(env, row, "fileId", value));
    struct Field { const char* name; int64_t number; };
    const Field fields[] = {{"size", entry.size}, {"creationTime", entry.creation}, {"lastAccessTime", entry.access}, {"lastWriteTime", entry.write}, {"changeTime", entry.change}};
    for (const auto& field : fields) {
      CHECK(napi_create_bigint_int64(env, field.number, &value)); CHECK(napi_set_named_property(env, row, field.name, value));
    }
    CHECK(napi_set_element(env, rows, static_cast<uint32_t>(index), row));
  }
  CHECK(napi_set_named_property(env, result, "entries", rows));
  CHECK(napi_create_bigint_uint64(env, job->volume, &value)); CHECK(napi_set_named_property(env, result, "volume", value));
  CHECK(napi_create_bigint_uint64(env, job->directory_id, &value)); CHECK(napi_set_named_property(env, result, "directoryId", value));
  CHECK(napi_create_uint32(env, job->batches, &value)); CHECK(napi_set_named_property(env, result, "batches", value));
  return result;
}
void Complete(napi_env env, napi_status status, void* data) {
  auto* job = static_cast<Job*>(data);
  Stop(job);
  if (!job->code && status != napi_ok) job->code = "Cancelled";
  if (!job->code && job->error) {
    switch (job->error) {
      case ERROR_FILE_NOT_FOUND: case ERROR_PATH_NOT_FOUND: job->code = "NotFound"; break;
      case ERROR_ACCESS_DENIED: job->code = "Denied"; break;
      case ERROR_NOT_SUPPORTED: case ERROR_INVALID_FUNCTION: case ERROR_INVALID_PARAMETER: job->code = "UnsupportedDirectoryQuery"; break;
      default: job->code = "NativeFailure";
    }
  }
  if (job->code) {
    napi_value error, number;
    if (napi_create_error(env, Text(env, job->code), Text(env, "Directory enumeration failed."), &error) != napi_ok) return;
    napi_create_uint32(env, job->error, &number); napi_set_named_property(env, error, "nativeCode", number);
    napi_set_named_property(env, error, "operation", Text(env, "files.readDirectory"));
    napi_reject_deferred(env, job->deferred, error);
  } else {
    napi_value result = Result(env, job); if (result) napi_resolve_deferred(env, job->deferred, result);
  }
}
napi_value Cancel(napi_env env, napi_callback_info info) {
  void* data = nullptr;
  CHECK(napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &data));
  static_cast<std::shared_ptr<std::atomic<bool>>*>(data)->get()->store(true);
  napi_value value; CHECK(napi_get_undefined(env, &value)); return value;
}
}
napi_value StartReadDirectory(napi_env env, const std::shared_ptr<SessionState>& state, napi_value request) {
  auto job = std::make_unique<Job>(); job->state = state;
  if (!Parse(env, request, &job->path)) return Fail(env, "InvalidRequest", "An absolute directory path without traversal is required.");
  napi_value promise, cancel;
  CHECK(napi_create_promise(env, &job->deferred, &promise));
  auto flag = std::make_unique<std::shared_ptr<std::atomic<bool>>>(job->cancelled);
  CHECK(napi_create_function(env, "cancel", NAPI_AUTO_LENGTH, Cancel, flag.get(), &cancel));
  CHECK(napi_add_finalizer(env, cancel, flag.get(), [](napi_env, void* data, void*) { delete static_cast<std::shared_ptr<std::atomic<bool>>*>(data); }, nullptr, nullptr));
  flag.release();
  CHECK(napi_set_named_property(env, promise, "cancel", cancel));
  CHECK(QueueWindowsWork(env, "files.readDirectory", std::move(job), Execute, Complete));
  return promise;
}

#include <node_api.h>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <new>
#include <memory>
#include <string>
#include <vector>
#include <exception>
#include <algorithm>
#include "session.h"
#include "git-status-native.h"
#ifdef __linux__
#include "binding-locks-linux.h"
#include "locks-linux.h"
#include "binding-desktop-linux.h"
#include "desktop-linux.h"
#endif
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include "windows-queries.h"
#include "windows-rename.h"
#include "binding-icons-win.h"
#include "binding-desktop-win.h"
#include "shell-context-win.h"
#include "windows-async-work.h"
#include "binding-transfer-win.h"
#include "file-transfer-win.h"
#include "clipboard-win.h"
#include "locks-win.h"
#endif

namespace {
constexpr const char* operations[] = {
  "files.copy", "files.rename", "clipboard.readFiles", "clipboard.writeFiles",
  "clipboard.acknowledge", "clipboard.cancelFiles", "shell.showContextMenu", "shell.openAssociated",
  "shell.openTrash", "shell.openTerminal", "icons.resolve", "metadata.query", "paths.resolveNetwork",
  "encoding.describe", "encoding.decodeBlock", "encoding.decodeChunk", "windows.resolveOwner",
  "windows.maximize", "locks.scan", "locks.releaseHandles", "locks.unloadModules", "locks.rename",
  "processes.terminate", "restartDeletion.prepare", "restartDeletion.commit", "git.status", "git.info"
};
const napi_type_tag session_tag = {0xc08f3d2b2abe4601ULL, 0xa16d35e8dc1a4b94ULL};
std::atomic<uint64_t> next_generation{1};
#ifdef _WIN32
bool IsLocksOperation(const char* operation) {
  return std::strcmp(operation, "locks.scan") == 0 || std::strcmp(operation, "locks.releaseHandles") == 0 ||
      std::strcmp(operation, "locks.unloadModules") == 0 || std::strcmp(operation, "locks.rename") == 0 ||
      std::strcmp(operation, "processes.terminate") == 0 || std::strcmp(operation, "restartDeletion.prepare") == 0 ||
      std::strcmp(operation, "restartDeletion.commit") == 0;
}
#endif
struct Session {
  std::shared_ptr<SessionState> state = std::make_shared<SessionState>();
  napi_ref closing = nullptr;
};

#define CHECK(call) do { if ((call) != napi_ok) { napi_throw_error(env, "BindingFailure", "Native binding failure."); return nullptr; } } while (false)

napi_value Fail(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message);
  return nullptr;
}

template<napi_callback Callback>
napi_value Guard(napi_env env, napi_callback_info info) {
  try { return Callback(env, info); }
  catch (const std::bad_alloc&) { return Fail(env, "ResourceExhausted", "Cannot allocate native resources."); }
  catch (const std::exception&) { return Fail(env, "BindingFailure", "Native operation failed."); }
}

napi_value Text(napi_env env, const char* value) {
  napi_value result;
  CHECK(napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result));
  return result;
}

Session* Unwrap(napi_env env, napi_value receiver) {
  bool tagged = false;
  if (napi_check_object_type_tag(env, receiver, &session_tag, &tagged) != napi_ok || !tagged) {
    Fail(env, "InvalidSession", "A native session receiver is required.");
    return nullptr;
  }
  void* data = nullptr;
  if (napi_unwrap(env, receiver, &data) != napi_ok || !data) {
    Fail(env, "InvalidSession", "The native session is invalid.");
    return nullptr;
  }
  return static_cast<Session*>(data);
}

napi_value Close(napi_env env, napi_callback_info info) {
  napi_value receiver;
  CHECK(napi_get_cb_info(env, info, nullptr, nullptr, &receiver, nullptr));
  Session* session = Unwrap(env, receiver);
  if (!session) return nullptr;
  const bool changed = !session->state->closed;
  session->state->closed = true;
#ifdef _WIN32
  if (changed) {
    CloseNativeLocksSession(session->state);
    napi_value closing = CloseWindowsClipboardSessionAsync(env, session->state);
    if (!closing) return nullptr;
    if (session->state->copy_session) {
      napi_value copy = ShutdownNativeCopies(env, session->state);
      if (!copy) return nullptr;
      napi_value global, constructor, all, promises, combined;
      CHECK(napi_get_global(env, &global));
      CHECK(napi_get_named_property(env, global, "Promise", &constructor));
      CHECK(napi_get_named_property(env, constructor, "all", &all));
      CHECK(napi_create_array_with_length(env, 2, &promises));
      CHECK(napi_set_element(env, promises, 0, closing));
      CHECK(napi_set_element(env, promises, 1, copy));
      CHECK(napi_call_function(env, constructor, all, 1, &promises, &combined));
      closing = combined;
    }
    CHECK(napi_create_reference(env, closing, 1, &session->closing));
  }
#endif
  napi_value result;
  CHECK(napi_get_boolean(env, changed, &result));
  return result;
}

napi_value WhenClosed(napi_env env, napi_callback_info info) {
  napi_value receiver;
  CHECK(napi_get_cb_info(env, info, nullptr, nullptr, &receiver, nullptr));
  Session* session = Unwrap(env, receiver);
  if (!session) return nullptr;
  napi_value promise;
  if (session->closing) {
    CHECK(napi_get_reference_value(env, session->closing, &promise));
    return promise;
  }
#ifdef __linux__
  return WhenLinuxLocksClosed(env, session->state);
#endif
  napi_deferred deferred;
  napi_value value;
  CHECK(napi_create_promise(env, &deferred, &promise));
  CHECK(napi_get_undefined(env, &value));
  CHECK(napi_resolve_deferred(env, deferred, value));
  return promise;
}

#ifdef _WIN32
struct MetadataJob {
  std::shared_ptr<SessionState> state;
  std::wstring path;
  napi_deferred deferred = nullptr;
  DWORD attributes = INVALID_FILE_ATTRIBUTES;
  DWORD error = ERROR_SUCCESS;
  bool short_name = false;
  std::wstring dos_name;
};

void ReadMetadata(napi_env, void* data) {
  auto* job = static_cast<MetadataJob*>(data);
  job->attributes = GetFileAttributesW(job->path.c_str());
  if (job->attributes == INVALID_FILE_ATTRIBUTES) job->error = GetLastError();
  else if (job->short_name) {
    WIN32_FIND_DATAW found{};
    const HANDLE search = FindFirstFileW(job->path.c_str(), &found);
    if (search != INVALID_HANDLE_VALUE) {
      job->dos_name = found.cAlternateFileName;
      if (job->dos_name.empty()) {
        BOOL legal = FALSE, spaces = FALSE;
        if (CheckNameLegalDOS8Dot3W(found.cFileName, nullptr, 0, &spaces, &legal) && legal && !spaces) job->dos_name = found.cFileName;
      }
      FindClose(search);
    }
  }
}

napi_value MetadataResult(napi_env env, MetadataJob* job) {
  napi_value result, attributes;
  CHECK(napi_create_object(env, &result));
  CHECK(napi_create_object(env, &attributes));
  struct Flag { const char* name; DWORD mask; };
  constexpr Flag flags[] = {
    {"readonly", FILE_ATTRIBUTE_READONLY}, {"hidden", FILE_ATTRIBUTE_HIDDEN},
    {"system", FILE_ATTRIBUTE_SYSTEM}, {"directory", FILE_ATTRIBUTE_DIRECTORY},
    {"archive", FILE_ATTRIBUTE_ARCHIVE}, {"compressed", FILE_ATTRIBUTE_COMPRESSED},
    {"encrypted", FILE_ATTRIBUTE_ENCRYPTED}, {"sparse", FILE_ATTRIBUTE_SPARSE_FILE},
    {"offline", FILE_ATTRIBUTE_OFFLINE}
  };
  for (const auto& flag : flags) {
    napi_value value;
    CHECK(napi_get_boolean(env, (job->attributes & flag.mask) != 0, &value));
    CHECK(napi_set_named_property(env, attributes, flag.name, value));
  }
  CHECK(napi_set_named_property(env, result, "attributes", attributes));
  CHECK(napi_set_named_property(env, result, "provenance", Text(env, "win32.fileAttributes")));
  if (job->short_name) {
    napi_value name;
    CHECK(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(job->dos_name.data()), job->dos_name.size(), &name));
    CHECK(napi_set_named_property(env, result, "dosName", name));
  }
  return result;
}

void CompleteMetadata(napi_env env, napi_status status, void* data) {
  auto* job = static_cast<MetadataJob*>(data);
  const char* code = nullptr;
  if (job->state->closed) code = "SessionClosed";
  else if (status != napi_ok) code = "Cancelled";
  else if (job->error == ERROR_FILE_NOT_FOUND || job->error == ERROR_PATH_NOT_FOUND) code = "NotFound";
  else if (job->error == ERROR_ACCESS_DENIED) code = "Denied";
  else if (job->error != ERROR_SUCCESS) code = "NativeFailure";
  if (code) {
    napi_value error, native_code;
    if (napi_create_error(env, Text(env, code), Text(env, "Native metadata query failed."), &error) != napi_ok) return;
    napi_create_uint32(env, job->error, &native_code);
    napi_set_named_property(env, error, "nativeCode", native_code);
    napi_set_named_property(env, error, "operation", Text(env, "metadata.query"));
    napi_reject_deferred(env, job->deferred, error);
  } else {
    napi_value result = MetadataResult(env, job);
    if (result) napi_resolve_deferred(env, job->deferred, result);
  }
}

napi_value QueryMetadata(napi_env env, Session* session, napi_value request) {
  napi_valuetype type;
  napi_value value;
  if (napi_typeof(env, request, &type) != napi_ok || type != napi_object ||
      napi_get_named_property(env, request, "path", &value) != napi_ok) {
    return Fail(env, "InvalidRequest", "An absolute path is required.");
  }
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || length == 0 || length > 32767) {
    return Fail(env, "InvalidRequest", "An absolute path is required.");
  }
  std::vector<char16_t> buffer(length + 1);
  CHECK(napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &length));
  const std::u16string target(buffer.data(), length);
  const bool drive = length >= 3 && ((target[0] >= u'A' && target[0] <= u'Z') || (target[0] >= u'a' && target[0] <= u'z')) && target[1] == u':' && (target[2] == u'\\' || target[2] == u'/');
  const bool unc = length > 4 && target[0] == u'\\' && target[1] == u'\\' && target[2] != u'.';
  if ((!drive && !unc) || target.find(u'\0') != std::u16string::npos) return Fail(env, "InvalidRequest", "An absolute path without embedded nulls is required.");
  auto job = std::make_unique<MetadataJob>();
  bool has_short_name = false;
  CHECK(napi_has_named_property(env, request, "shortName", &has_short_name));
  if (has_short_name) {
    CHECK(napi_get_named_property(env, request, "shortName", &value));
    if (napi_get_value_bool(env, value, &job->short_name) != napi_ok) return Fail(env, "InvalidRequest", "shortName must be a boolean.");
  }
  job->state = session->state;
  job->path.assign(target.begin(), target.end());
  std::replace(job->path.begin(), job->path.end(), L'/', L'\\');
  if (job->path.substr(0, 4) != L"\\\\?\\") {
    const DWORD count = GetFullPathNameW(job->path.c_str(), 0, nullptr, nullptr);
    if (!count || count > 32767) return Fail(env, "InvalidRequest", "The absolute path cannot be normalized.");
    std::vector<wchar_t> normalized(count);
    const DWORD written = GetFullPathNameW(job->path.c_str(), count, normalized.data(), nullptr);
    if (!written || written >= count) return Fail(env, "InvalidRequest", "The absolute path cannot be normalized.");
    const std::wstring full(normalized.data(), written);
    job->path = full.substr(0, 2) == L"\\\\" ? L"\\\\?\\UNC\\" + full.substr(2) : L"\\\\?\\" + full;
  }
  napi_value promise;
  CHECK(napi_create_promise(env, &job->deferred, &promise));
  if (QueueWindowsWork(env, "metadata.query", std::move(job), ReadMetadata, CompleteMetadata) != napi_ok) {
    return Fail(env, "BindingFailure", "Cannot queue native metadata work.");
  }
  return promise;
}
#endif

napi_value Invoke(napi_env env, napi_callback_info info) {
  size_t count = 3;
  napi_value args[3], receiver;
  CHECK(napi_get_cb_info(env, info, &count, args, &receiver, nullptr));
  Session* session = Unwrap(env, receiver);
  if (!session) return nullptr;
  if (session->state->closed) return Fail(env, "SessionClosed", "The native session is closed.");
  char operation[64];
  size_t length = 0;
  if (count < 1 || napi_get_value_string_utf8(env, args[0], operation, sizeof(operation), &length) != napi_ok || length >= sizeof(operation) - 1) {
    return Fail(env, "UnknownOperation", "Unknown native operation.");
  }
  for (const char* known : operations) {
    if (length == std::strlen(known) && std::memcmp(operation, known, length) == 0) {
#ifdef _WIN32
      if (IsLocksOperation(known)) {
        if (count != 2) return Fail(env, "InvalidRequest", "A lock operation request is required.");
        if (!NativeLocksSupported()) return Fail(env, "UnsupportedOperation", "The Windows lock adapter is unavailable.");
        return StartNativeLocks(env, session->state, known, args[1]);
      }
      if (std::strcmp(known, "files.copy") == 0) {
        if (count < 2) return Fail(env, "InvalidRequest", "A copy request is required.");
        napi_value progress;
        if (count >= 3) progress = args[2]; else CHECK(napi_get_undefined(env, &progress));
        return StartNativeCopy(env, session->state, args[1], progress);
      }
      if (IsWindowsClipboardOperation(known)) {
        if (count != 2) return Fail(env, "InvalidRequest", "A file clipboard request is required.");
        return StartWindowsClipboardQuery(env, session->state, known, args[1]);
      }
      if (std::strcmp(known, "shell.openAssociated") == 0) {
        if (count != 2) return Fail(env, "InvalidRequest", "A desktop association request is required.");
        return StartNativeDesktopAssociation(env, session->state, args[1]);
      }
      if (std::strcmp(known, "shell.openTerminal") == 0) {
        if (count != 2) return Fail(env, "InvalidRequest", "A terminal request is required.");
        return StartNativeTerminal(env, session->state, args[1]);
      }
      if (std::strcmp(known, "shell.openTrash") == 0) {
        if (count != 2) return Fail(env, "InvalidRequest", "A trash-view request is required.");
        return StartNativeTrash(env, session->state, args[1]);
      }
      if (std::strcmp(known, "shell.showContextMenu") == 0) {
        if (count != 2) return Fail(env, "InvalidRequest", "A shell-menu request is required.");
        return StartNativeShellContextMenu(env, session->state, args[1]);
      }
      if (std::strcmp(known, "windows.maximize") == 0) {
        if (count != 2) return Fail(env, "InvalidRequest", "A window request is required.");
        return StartNativeMaximize(env, session->state, args[1]);
      }
      if (std::strcmp(known, "icons.resolve") == 0) {
        if (count != 2) return Fail(env, "InvalidRequest", "An icon request is required.");
        return StartNativeIcons(env, session->state, args[1]);
      }
      if (std::strcmp(known, "files.rename") == 0) {
        if (count != 2) return Fail(env, "InvalidRequest", "A rename request is required.");
        return StartCaseRename(env, session->state, args[1]);
      }
      if (IsWindowsQuery(known)) {
        if (count != 2) return Fail(env, "InvalidRequest", "A query request is required.");
        return StartWindowsQuery(env, session->state, known, args[1]);
      }
      if (std::strcmp(known, "metadata.query") == 0) {
        if (count != 2) return Fail(env, "InvalidRequest", "A metadata request is required.");
        return QueryMetadata(env, session, args[1]);
      }
#endif
#ifdef __linux__
      if (IsLinuxDesktopOperation(known)) {
        if (count != 2) return Fail(env, "InvalidRequest", "A Linux desktop request is required.");
        return StartLinuxDesktop(env, session->state, known, args[1]);
      }
      if (IsLinuxLocksOperation(known)) {
        if (count != 2) return Fail(env, "InvalidRequest", "A Linux lock request is required.");
        return StartLinuxLocks(env, session->state, known, args[1]);
      }
#endif
      if (IsGitStatusOperation(known)) {
        if (count < 2 || count > 3) return Fail(env, "InvalidRequest", "A Git status request is required.");
        napi_value progress;
        if (count == 3) progress = args[2]; else CHECK(napi_get_undefined(env, &progress));
        return StartGitStatus(env, session->state, args[1], progress);
      }
      if (std::strcmp(known, "git.info") == 0) {
        if (count != 2) return Fail(env, "InvalidRequest", "A Git metadata request is required.");
        return StartGitInfo(env, session->state, args[1]);
      }
      return Fail(env, "UnsupportedOperation", "The native operation is not implemented.");
    }
  }
  return Fail(env, "UnknownOperation", "Unknown native operation.");
}

void Finalize(napi_env env, void* data, void*) {
  auto* session = static_cast<Session*>(data);
  session->state->closed = true;
#ifdef _WIN32
  CloseNativeLocksSession(session->state);
  CloseWindowsClipboardSession(session->state);
  if (session->state->copy_session) session->state->copy_session->Shutdown();
#endif
  if (session->closing) napi_delete_reference(env, session->closing);
  delete session;
}

napi_value Open(napi_env env, napi_callback_info) {
  napi_value result, generation;
  CHECK(napi_create_object(env, &result));
  CHECK(napi_create_bigint_uint64(env, next_generation.fetch_add(1), &generation));
  CHECK(napi_set_named_property(env, result, "generation", generation));
  const napi_property_descriptor methods[] = {
    {"close", nullptr, Guard<Close>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"whenClosed", nullptr, Guard<WhenClosed>, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"invoke", nullptr, Guard<Invoke>, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  CHECK(napi_define_properties(env, result, 3, methods));
  CHECK(napi_type_tag_object(env, result, &session_tag));
  auto* session = new (std::nothrow) Session;
  if (!session) return Fail(env, "ResourceExhausted", "Cannot allocate a native session.");
  if (napi_wrap(env, result, session, Finalize, nullptr, nullptr) != napi_ok) {
    delete session;
    return Fail(env, "BindingFailure", "Cannot retain a native session.");
  }
  CHECK(napi_object_freeze(env, result));
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  InitializeGitStatus(env);
  napi_value version, major, minor, capabilities;
  CHECK(napi_create_object(env, &version));
  CHECK(napi_create_uint32(env, 1, &major));
  CHECK(napi_create_uint32(env, 2, &minor));
  CHECK(napi_set_named_property(env, version, "major", major));
  CHECK(napi_set_named_property(env, version, "minor", minor));
  CHECK(napi_object_freeze(env, version));
  CHECK(napi_set_named_property(env, exports, "apiVersion", version));
  CHECK(napi_create_object(env, &capabilities));
  for (const char* operation : operations) {
    napi_value entry;
    CHECK(napi_create_object(env, &entry));
    bool supported = std::strcmp(operation, "git.status") == 0 || std::strcmp(operation, "git.info") == 0;
    bool locks = false;
    bool desktop = false;
#ifdef __linux__
    const auto linux_locks = native_linux::ProbeCapabilities();
    locks = (std::strcmp(operation, "locks.rename") == 0 && linux_locks.rename) ||
        (std::strcmp(operation, "processes.terminate") == 0 && linux_locks.terminate);
    desktop = IsLinuxDesktopOperation(operation) && ProbeLinuxDesktop();
    supported = supported || locks || desktop;
#endif
#ifdef _WIN32
    supported = std::strcmp(operation, "shell.openTerminal") == 0 || std::strcmp(operation, "git.status") == 0 || std::strcmp(operation, "git.info") == 0 || std::strcmp(operation, "metadata.query") == 0 || std::strcmp(operation, "files.rename") == 0 || std::strcmp(operation, "files.copy") == 0 || std::strcmp(operation, "icons.resolve") == 0 || std::strcmp(operation, "shell.openAssociated") == 0 || std::strcmp(operation, "shell.openTrash") == 0 || std::strcmp(operation, "shell.showContextMenu") == 0 || std::strcmp(operation, "windows.maximize") == 0 || IsWindowsQuery(operation) || IsWindowsClipboardOperation(operation);
    locks = IsLocksOperation(operation) && NativeLocksSupported();
    supported = supported || locks;
#endif
    const bool rename = std::strcmp(operation, "files.rename") == 0 && supported;
    const bool codepage = (std::strcmp(operation, "encoding.decodeBlock") == 0 || std::strcmp(operation, "encoding.decodeChunk") == 0) && supported;
    const bool conditional = codepage || rename || locks || desktop;
    CHECK(napi_set_named_property(env, entry, "status", Text(env, conditional ? "conditional" : supported ? "supported" : "unsupported")));
    if (conditional) {
      const char* lock_reason = "Windows10Or11X64AndProcessAccess";
#ifdef __linux__
      lock_reason = "LinuxKernelSupportAndProcessAccess";
#endif
      CHECK(napi_set_named_property(env, entry, "reason", Text(env, desktop ? "GioDesktopSessionAndAssociation" : locks ? lock_reason : rename ? "CaseOnlySameDirectory" : "SingleDoubleByteUtf8AndGB18030Codepages")));
    }
    if (codepage) {
      napi_value max_bytes;
      CHECK(napi_create_uint32(env, 1048576, &max_bytes));
      CHECK(napi_set_named_property(env, entry, "maxBytes", max_bytes));
    }
    if (std::strcmp(operation, "git.status") == 0) {
      napi_value dirty_summary;
      CHECK(napi_get_boolean(env, true, &dirty_summary));
      CHECK(napi_set_named_property(env, entry, "dirtySummary", dirty_summary));
    }
    if (!supported) {
      const char* reason = "NotImplemented";
#ifdef _WIN32
      if (IsLocksOperation(operation)) reason = "UnsupportedWindowsVersionOrArchitecture";
#endif
      CHECK(napi_set_named_property(env, entry, "reason", Text(env, reason)));
    }
    CHECK(napi_object_freeze(env, entry));
    CHECK(napi_set_named_property(env, capabilities, operation, entry));
  }
  CHECK(napi_object_freeze(env, capabilities));
  CHECK(napi_set_named_property(env, exports, "capabilities", capabilities));
  const napi_property_descriptor open = {"openSession", nullptr, Guard<Open>, nullptr, nullptr, nullptr, napi_default, nullptr};
  CHECK(napi_define_properties(env, exports, 1, &open));
  CHECK(napi_object_freeze(env, exports));
  return exports;
}
}

NAPI_MODULE(binding, Init)



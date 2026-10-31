#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>
#include "locks-win.h"

class MemoryPendingStore final : public PendingRenameStore {
 public:
  std::vector<uint8_t> bytes;
  bool exists = false;
  size_t queue_calls = 0;
  size_t queued = 0;
  size_t fail_on_call = 0;
  size_t append_concurrent_on_call = 0;
  bool fail_read_after_queue = false;
  bool case_fold_first_queue = false;
  bool Read(std::vector<uint8_t>* output, bool* present, DWORD* error) override {
    if (fail_read_after_queue && queued != 0) { if (present) *present = exists; if (error) *error = ERROR_READ_FAULT; return false; }
    *output = bytes;
    *present = exists;
    return true;
  }
  bool QueueDelete(const std::wstring& path, DWORD* error) override {
    ++queue_calls;
    if (fail_on_call != 0 && queue_calls == fail_on_call) {
      if (error) *error = ERROR_ACCESS_DENIED;
      return false;
    }
    std::vector<std::wstring> values;
    if (exists) {
      if (bytes.size() % sizeof(wchar_t) != 0) { if (error) *error = ERROR_INVALID_DATA; return false; }
      const auto* data = reinterpret_cast<const wchar_t*>(bytes.data());
      const size_t count = bytes.size() / sizeof(wchar_t);
      size_t offset = 0;
      while (offset < count && data[offset] != L'\0') {
        size_t source_end = offset;
        while (source_end < count && data[source_end] != L'\0') ++source_end;
        if (source_end == count) { if (error) *error = ERROR_INVALID_DATA; return false; }
        values.emplace_back(data + offset, source_end - offset);
        offset = source_end + 1;
        size_t target_end = offset;
        while (target_end < count && data[target_end] != L'\0') ++target_end;
        if (target_end == count) { if (error) *error = ERROR_INVALID_DATA; return false; }
        values.emplace_back(data + offset, target_end - offset);
        offset = target_end + 1;
      }
    }
    std::wstring source = path.rfind(L"\\\\", 0) == 0 ? L"\\??\\UNC\\" + path.substr(2) : L"\\??\\" + path;
    if (case_fold_first_queue && queue_calls == 1 && source.size() > 4 && source[4] >= L'A' && source[4] <= L'Z') source[4] = static_cast<wchar_t>(source[4] - L'A' + L'a');
    values.push_back(source);
    values.emplace_back();
    if (append_concurrent_on_call == queue_calls) {
      values.emplace_back(L"\\??\\C:\\concurrent-source");
      values.emplace_back(L"C:\\concurrent-destination");
    }
    size_t count = 1;
    for (const auto& value : values) count += value.size() + 1;
    if (values.empty()) count = 2;
    std::vector<wchar_t> encoded(count, L'\0');
    size_t offset = 0;
    for (const auto& value : values) {
      std::copy(value.begin(), value.end(), encoded.begin() + offset);
      offset += value.size() + 1;
    }
    bytes.resize(encoded.size() * sizeof(wchar_t));
    memcpy(bytes.data(), encoded.data(), bytes.size());
    exists = true;
    ++queued;
    return true;
  }
};

bool ResolveWithStore(const char* operation, const NativeLocksRequest& request,
                      const std::atomic<bool>& closed, NativeLocksResult* result,
                      DWORD* error, NativeLocksSessionState* session,
                      PendingRenameStore& store) {
  return ResolveNativeLocksWithStoreForTesting(operation, request, closed, result, error, session, store);
}

int RunNativeLocksRegistryProbe() {
  wchar_t base[MAX_PATH]{};
  if (!GetTempPathW(MAX_PATH, base)) return 1;
  const std::wstring root = std::wstring(base) + L"native-locks-registry-probe-" + std::to_wstring(GetCurrentProcessId());
  const std::wstring target = root + L"\\target";
  const std::wstring backup_dir = root + L"\\backups";
  const std::wstring nested_backup_dir = backup_dir + L"\\nested";
  const std::wstring nested_backup_parent = nested_backup_dir + L"\\deeper";
  const std::wstring backup = backup_dir + L"\\before.reg";
  const std::wstring second_backup = backup_dir + L"\\existing.reg";
  const std::wstring stale_backup = backup_dir + L"\\stale.reg";
  const std::wstring api_backup = backup_dir + L"\\api-before.reg";
  const std::wstring registry_backup = backup_dir + L"\\registry-change.reg";
  const std::wstring list_backup = backup_dir + L"\\list-change.reg";
  const std::wstring missing_backup = backup_dir + L"\\missing-backup.reg";
  const std::wstring changed_backup = backup_dir + L"\\changed-backup.reg";
  const std::wstring closed_backup = backup_dir + L"\\closed-session.reg";
  const std::wstring first_fail_backup = backup_dir + L"\\first-fail.reg";
  const std::wstring second_fail_backup = backup_dir + L"\\second-fail.reg";
  const std::wstring concurrent_backup = backup_dir + L"\\concurrent.reg";
  const std::wstring verify_fail_backup = backup_dir + L"\\verify-fail.reg";
  const std::wstring nested_backup = nested_backup_parent + L"\\before.reg";
  const std::wstring file = target + L"\\child.txt";
  struct Cleanup {
    std::wstring root, target, backup_dir, nested_backup_dir, nested_backup_parent, file;
    std::vector<std::wstring> backups;
    ~Cleanup() { for (const auto& value : backups) DeleteFileW(value.c_str()); DeleteFileW(file.c_str()); RemoveDirectoryW(target.c_str()); RemoveDirectoryW(nested_backup_parent.c_str()); RemoveDirectoryW(nested_backup_dir.c_str()); RemoveDirectoryW(backup_dir.c_str()); RemoveDirectoryW(root.c_str()); }
  } cleanup{root, target, backup_dir, nested_backup_dir, nested_backup_parent, file, {backup, second_backup, stale_backup, api_backup, registry_backup, list_backup, missing_backup, changed_backup, closed_backup, first_fail_backup, second_fail_backup, concurrent_backup, verify_fail_backup, nested_backup}};
  if (!CreateDirectoryW(root.c_str(), nullptr) || !CreateDirectoryW(target.c_str(), nullptr) || !CreateDirectoryW(backup_dir.c_str(), nullptr)) return 2;
  HANDLE content = CreateFileW(file.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (content == INVALID_HANDLE_VALUE) return 2;
  CloseHandle(content);

  DWORD error = ERROR_SUCCESS;
  MemoryPendingStore store;
  PreparedRestartDeletion prepared;
  if (!PrepareRestartDeletion(target, backup, store, &prepared, &error)) return 3;
  if (store.queue_calls != 0 || prepared.files.size() != 2 || GetFileAttributesW(backup.c_str()) == INVALID_FILE_ATTRIBUTES) return 4;
  uint32_t changed = 0;
  if (!CommitRestartDeletion(target, backup, prepared, store, &changed, &error)) { std::cerr << "commit nativeError=" << error << std::endl; return 5; }
  if (store.queue_calls != 2 || store.queued != 2 || changed != 2 || !store.exists || store.bytes.size() < sizeof(wchar_t) * 4) return 6;

  const wchar_t previous_value[] = L"\\??\\C:\\prior-source\0C:\\prior-target\0";
  MemoryPendingStore existing_store;
  existing_store.exists = true;
  const auto* prior_data = reinterpret_cast<const uint8_t*>(previous_value);
  existing_store.bytes.assign(prior_data, prior_data + sizeof(previous_value));
  PreparedRestartDeletion existing;
  if (!PrepareRestartDeletion(target, second_backup, existing_store, &existing, &error) || existing_store.queue_calls != 0) return 7;
  if (!CommitRestartDeletion(target, second_backup, existing, existing_store, &changed, &error) || existing_store.queue_calls != 2) return 8;
  const std::wstring resulting(reinterpret_cast<const wchar_t*>(existing_store.bytes.data()), existing_store.bytes.size() / sizeof(wchar_t));
  if (resulting.find(L"\\??\\C:\\prior-source") == std::wstring::npos || resulting.find(L"C:\\prior-target") == std::wstring::npos || resulting.find(L"\\??\\" + file) == std::wstring::npos) return 9;

  MemoryPendingStore stale_store;
  PreparedRestartDeletion stale;
  if (!PrepareRestartDeletion(target, stale_backup, stale_store, &stale, &error)) return 10;
  stale_store.bytes = {1, 2};
  stale_store.exists = true;
  if (CommitRestartDeletion(target, stale_backup, stale, stale_store, &changed, &error) || stale_store.queue_calls != 0 || error != ERROR_RETRY) return 11;

  NativeLocksSessionState session_a, session_b;
  std::atomic<bool> session_closed{false};
  PreparedRestartDeletion token_state;
  token_state.path = target;
  token_state.backup = backup;
  token_state.token = L"fixture-token";
  if (!session_a.Store(token_state, session_closed)) return 12;
  PreparedRestartDeletion taken;
  if (session_b.Take(token_state.token, target, backup, session_closed, &taken)) return 13;
  if (!session_a.Take(token_state.token, target, backup, session_closed, &taken) || taken.token != token_state.token) return 14;
  if (!session_a.Store(token_state, session_closed)) return 15;
  session_a.Close();
  if (!session_a.prepared_deletions.empty() || session_a.Store(token_state, session_closed) ||
      session_a.Take(token_state.token, target, backup, session_closed, &taken)) return 16;

  NativeLocksRequest api_request;
  api_request.path = target;
  api_request.backup = api_backup;
  const wchar_t api_prior[] = L"\\??\\C:\\preserved-source\0C:\\preserved-target\0";
  MemoryPendingStore api_store;
  api_store.exists = true;
  const auto* api_prior_bytes = reinterpret_cast<const uint8_t*>(api_prior);
  api_store.bytes.assign(api_prior_bytes, api_prior_bytes + sizeof(api_prior));
  NativeLocksSessionState api_session_a, api_session_b;
  NativeLocksResult api_result;
  std::atomic<bool> api_open{false};
  if (!ResolveWithStore("restartDeletion.prepare", api_request, api_open, &api_result, &error, &api_session_a, api_store)) return 17;
  const std::wstring api_token = api_result.token;
  if (api_token.empty() || api_store.queue_calls != 0 || GetFileAttributesW(api_request.backup.c_str()) == INVALID_FILE_ATTRIBUTES) return 18;
  api_request.token = api_token;
  api_result = {};
  if (ResolveWithStore("restartDeletion.commit", api_request, api_open, &api_result, &error, &api_session_b, api_store) ||
      error != ERROR_INVALID_DATA || api_store.queue_calls != 0) return 19;
  api_result = {};
  if (!ResolveWithStore("restartDeletion.commit", api_request, api_open, &api_result, &error, &api_session_a, api_store) ||
      api_result.changed != 2 || api_store.queue_calls != 2 || api_result.queue_outcome != L"committed") return 20;
  const std::wstring api_pairs(reinterpret_cast<const wchar_t*>(api_store.bytes.data()), api_store.bytes.size() / sizeof(wchar_t));
  if (api_pairs.find(L"\\??\\C:\\preserved-source") == std::wstring::npos ||
      api_pairs.find(L"C:\\preserved-target") == std::wstring::npos) return 21;
  api_result = {};
  if (ResolveWithStore("restartDeletion.commit", api_request, api_open, &api_result, &error, &api_session_a, api_store) ||
      error != ERROR_INVALID_DATA || api_store.queue_calls != 2) return 22;

  const auto prepare_case = [&](const std::wstring& case_backup, MemoryPendingStore* case_store,
                                NativeLocksSessionState* case_session, NativeLocksRequest* case_request,
                                NativeLocksResult* case_result) {
    *case_request = {};
    case_request->path = target;
    case_request->backup = case_backup;
    *case_result = {};
    return ResolveWithStore("restartDeletion.prepare", *case_request, api_open, case_result, &error, case_session, *case_store);
  };

  MemoryPendingStore registry_store;
  NativeLocksSessionState registry_session;
  NativeLocksRequest registry_request;
  NativeLocksResult registry_result;
  if (!prepare_case(registry_backup, &registry_store, &registry_session, &registry_request, &registry_result) || registry_store.queue_calls != 0) return 23;
  registry_request.token = registry_result.token;
  registry_store.bytes.push_back(0x7f);
  registry_result = {};
  if (ResolveWithStore("restartDeletion.commit", registry_request, api_open, &registry_result, &error, &registry_session, registry_store) ||
      error != ERROR_RETRY || registry_store.queue_calls != 0) return 24;

  MemoryPendingStore list_store;
  NativeLocksSessionState list_session;
  NativeLocksRequest list_request;
  NativeLocksResult list_result;
  if (!prepare_case(list_backup, &list_store, &list_session, &list_request, &list_result)) return 25;
  list_request.token = list_result.token;
  const std::wstring extra_file = target + L"\\added-after-prepare.txt";
  HANDLE extra = CreateFileW(extra_file.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (extra == INVALID_HANDLE_VALUE) return 26;
  CloseHandle(extra);
  list_result = {};
  const bool list_commit = ResolveWithStore("restartDeletion.commit", list_request, api_open, &list_result, &error, &list_session, list_store);
  DeleteFileW(extra_file.c_str());
  if (list_commit || error != ERROR_RETRY || list_store.queue_calls != 0) return 27;

  MemoryPendingStore missing_store;
  NativeLocksSessionState missing_session;
  NativeLocksRequest missing_request;
  NativeLocksResult missing_result;
  if (!prepare_case(missing_backup, &missing_store, &missing_session, &missing_request, &missing_result)) return 28;
  missing_request.token = missing_result.token;
  if (!DeleteFileW(missing_backup.c_str())) return 29;
  missing_result = {};
  if (ResolveWithStore("restartDeletion.commit", missing_request, api_open, &missing_result, &error, &missing_session, missing_store) ||
      error != ERROR_FILE_NOT_FOUND || missing_store.queue_calls != 0) return 30;

  MemoryPendingStore changed_store;
  NativeLocksSessionState changed_session;
  NativeLocksRequest changed_request;
  NativeLocksResult changed_result;
  if (!prepare_case(changed_backup, &changed_store, &changed_session, &changed_request, &changed_result)) return 31;
  changed_request.token = changed_result.token;
  HANDLE altered = CreateFileW(changed_backup.c_str(), GENERIC_WRITE, 0, nullptr, TRUNCATE_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (altered == INVALID_HANDLE_VALUE) return 32;
  const char tamper[] = "changed";
  DWORD tamper_size = 0;
  const bool altered_ok = WriteFile(altered, tamper, sizeof(tamper), &tamper_size, nullptr) && tamper_size == sizeof(tamper);
  CloseHandle(altered);
  if (!altered_ok) return 33;
  changed_result = {};
  if (ResolveWithStore("restartDeletion.commit", changed_request, api_open, &changed_result, &error, &changed_session, changed_store) ||
      error != ERROR_RETRY || changed_store.queue_calls != 0) return 34;

  MemoryPendingStore closed_store;
  NativeLocksSessionState closed_session;
  NativeLocksRequest closed_request;
  NativeLocksResult closed_result;
  if (!prepare_case(closed_backup, &closed_store, &closed_session, &closed_request, &closed_result)) return 35;
  closed_request.token = closed_result.token;
  closed_session.Close();
  closed_result = {};
  if (ResolveWithStore("restartDeletion.commit", closed_request, api_open, &closed_result, &error, &closed_session, closed_store) ||
      error != ERROR_INVALID_DATA || closed_store.queue_calls != 0) return 36;

  MemoryPendingStore first_fail_store;
  NativeLocksSessionState first_fail_session;
  NativeLocksRequest first_fail_request;
  NativeLocksResult first_fail_result;
  if (!prepare_case(first_fail_backup, &first_fail_store, &first_fail_session, &first_fail_request, &first_fail_result)) return 37;
  first_fail_request.token = first_fail_result.token;
  first_fail_store.fail_on_call = 1;
  first_fail_result = {};
  if (ResolveWithStore("restartDeletion.commit", first_fail_request, api_open, &first_fail_result, &error, &first_fail_session, first_fail_store) ||
      error != ERROR_ACCESS_DENIED || first_fail_result.changed != 0 || first_fail_result.queued_count != 0 ||
      first_fail_result.queue_outcome != L"unchanged" || first_fail_store.queue_calls != 1) return 38;

  MemoryPendingStore second_fail_store;
  NativeLocksSessionState second_fail_session;
  NativeLocksRequest second_fail_request;
  NativeLocksResult second_fail_result;
  if (!prepare_case(second_fail_backup, &second_fail_store, &second_fail_session, &second_fail_request, &second_fail_result)) return 39;
  second_fail_request.token = second_fail_result.token;
  second_fail_store.fail_on_call = 2;
  second_fail_result = {};
  if (ResolveWithStore("restartDeletion.commit", second_fail_request, api_open, &second_fail_result, &error, &second_fail_session, second_fail_store) ||
      error != ERROR_ACCESS_DENIED || second_fail_result.changed != 1 || second_fail_result.queued_count != 1 ||
      second_fail_result.queue_outcome != L"partial" || second_fail_result.errors.empty() || second_fail_store.queued != 1) return 40;

  MemoryPendingStore concurrent_store;
  NativeLocksSessionState concurrent_session;
  NativeLocksRequest concurrent_request;
  NativeLocksResult concurrent_result;
  if (!prepare_case(concurrent_backup, &concurrent_store, &concurrent_session, &concurrent_request, &concurrent_result)) return 41;
  concurrent_request.token = concurrent_result.token;
  concurrent_store.append_concurrent_on_call = 1;
  concurrent_store.case_fold_first_queue = true;
  concurrent_result = {};
  if (!ResolveWithStore("restartDeletion.commit", concurrent_request, api_open, &concurrent_result, &error, &concurrent_session, concurrent_store) ||
      concurrent_result.queue_outcome != L"committed" || concurrent_result.changed != 2 || concurrent_store.queue_calls != 2) return 42;
  const std::wstring concurrent_pairs(reinterpret_cast<const wchar_t*>(concurrent_store.bytes.data()), concurrent_store.bytes.size() / sizeof(wchar_t));
  if (concurrent_pairs.find(L"\\??\\C:\\concurrent-source") == std::wstring::npos ||
      concurrent_pairs.find(L"C:\\concurrent-destination") == std::wstring::npos) return 43;

  MemoryPendingStore verify_fail_store;
  NativeLocksSessionState verify_fail_session;
  NativeLocksRequest verify_fail_request;
  NativeLocksResult verify_fail_result;
  if (!prepare_case(verify_fail_backup, &verify_fail_store, &verify_fail_session, &verify_fail_request, &verify_fail_result)) return 44;
  verify_fail_request.token = verify_fail_result.token;
  verify_fail_store.fail_read_after_queue = true;
  verify_fail_result = {};
  if (ResolveWithStore("restartDeletion.commit", verify_fail_request, api_open, &verify_fail_result, &error, &verify_fail_session, verify_fail_store) ||
      error != ERROR_READ_FAULT || verify_fail_result.changed != 2 || verify_fail_result.queued_count != 2 ||
      verify_fail_result.queue_outcome != L"unknown") return 45;

  MemoryPendingStore nested_store;
  NativeLocksSessionState nested_session;
  NativeLocksRequest nested_request;
  NativeLocksResult nested_result;
  if (!prepare_case(nested_backup, &nested_store, &nested_session, &nested_request, &nested_result) ||
      nested_store.queue_calls != 0 || GetFileAttributesW(nested_backup.c_str()) == INVALID_FILE_ATTRIBUTES) return 46;

  std::cout << "prepare=ok commit=ok existing-pairs=preserved concurrent-pairs=preserved stale-registry=rejected changed-list=rejected missing-backup=rejected changed-backup=rejected nested-backup=ok session-tokens=isolated first-failure=unchanged second-failure=partial verify-failure=unknown result=ok" << std::endl;
  return 0;
}

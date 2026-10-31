#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "../native/src/file-transfer-win.h"

namespace {
constexpr uint64_t kSourceBytes = 64ULL * 1024ULL * 1024ULL;
constexpr DWORD kChunkBytes = 64U * 1024U;
std::wstring active_target_path;
std::atomic<bool> mutate_before_path_check{false};
std::atomic<bool> mutation_applied{false};
std::atomic<bool> mutation_was_same_inode{false};
std::atomic<DWORD> mutation_error{ERROR_SUCCESS};
FileTransferOwnedDestination last_progress_witness;
bool have_progress_witness = false;

void RecordAndMutate(HANDLE file);

HANDLE WINAPI CreateFileForNative(LPCWSTR path, DWORD access, DWORD share, LPSECURITY_ATTRIBUTES security,
                                  DWORD creation, DWORD flags, HANDLE template_file) {
  const std::wstring extended_target = active_target_path.compare(0, 2, L"\\\\") == 0
      ? L"\\\\?\\UNC\\" + active_target_path.substr(2)
      : L"\\\\?\\" + active_target_path;
  const bool is_target_probe = path && CompareStringOrdinal(path, -1, extended_target.c_str(), -1, TRUE) == CSTR_EQUAL &&
      access == FILE_READ_ATTRIBUTES && creation == OPEN_EXISTING;
  if (is_target_probe && mutate_before_path_check.exchange(false)) {
    HANDLE mutation = ::CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (mutation == INVALID_HANDLE_VALUE) {
      mutation_error.store(GetLastError());
    } else {
      RecordAndMutate(mutation);
      if (!CloseHandle(mutation)) mutation_error.store(GetLastError());
    }
  }
  return ::CreateFileW(path, access, share, security, creation, flags, template_file);
}
}

#define CreateFileW CreateFileForNative
#include "../native/src/file-transfer-win.cc"
#undef CreateFileW

namespace {
void RecordAndMutate(HANDLE file) {
  const NativeHandleIdentity before = Identity(file);
  mutation_was_same_inode.store(have_progress_witness &&
      before.reported.dev == last_progress_witness.identity.dev && before.reported.ino == last_progress_witness.identity.ino);
  LARGE_INTEGER beginning{};
  if (!SetFilePointerEx(file, beginning, nullptr, FILE_BEGIN)) {
    mutation_error.store(GetLastError());
    return;
  }
  const unsigned char foreign_byte = 0xa5;
  DWORD written = 0;
  if (!WriteFile(file, &foreign_byte, 1, &written, nullptr)) {
    mutation_error.store(GetLastError());
    return;
  }
  if (written != 1) {
    mutation_error.store(ERROR_WRITE_FAULT);
    return;
  }
  mutation_applied.store(true);
}

bool WriteSource(const std::wstring& path) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  std::vector<unsigned char> bytes(kChunkBytes, 0x5a);
  uint64_t remaining = kSourceBytes;
  bool ok = true;
  while (remaining && ok) {
    DWORD written = 0;
    const DWORD count = static_cast<DWORD>(remaining < bytes.size() ? remaining : bytes.size());
    ok = WriteFile(file, bytes.data(), count, &written, nullptr) != FALSE && written == count;
    remaining -= ok ? written : 0;
  }
  if (!CloseHandle(file)) ok = false;
  return ok && remaining == 0;
}

bool SourceIsIntact(const std::wstring& path) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  std::vector<unsigned char> bytes(kChunkBytes);
  uint64_t total = 0;
  bool ok = true;
  while (ok) {
    DWORD read = 0;
    ok = ReadFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) != FALSE;
    for (DWORD i = 0; ok && i < read; ++i) ok = bytes[i] == 0x5a;
    total += read;
    if (!read) break;
  }
  if (!CloseHandle(file)) ok = false;
  return ok && total == kSourceBytes;
}

bool TargetMissing(const std::wstring& path) {
  const DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes != INVALID_FILE_ATTRIBUTES) return false;
  const DWORD error = GetLastError();
  return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
}

bool TargetMatchesWitness(const std::wstring& path, const FileTransferOwnedDestination& witness) {
  try {
    Handle target = Open(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    return SameIdentity(Identity(target.value), witness.identity);
  } catch (...) {
    return false;
  }
}

FileTransferResult CopyAndCancel(const std::wstring& source, const std::wstring& target, const std::wstring& root,
                                 bool cancel, bool* saw_progress, uint64_t* total) {
  FileTransferRequest request;
  request.source = source;
  request.target = target;
  request.roots = {root};
  {
    Handle handle = Open(source, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    request.expected_source = Identity(handle.value).reported;
  }
  auto session = CreateNativeFileTransferSession();
  std::atomic<bool> cancel_requested{false};
  *saw_progress = false;
  *total = 0;
  last_progress_witness = {};
  have_progress_witness = false;
  FileTransferResult result;
  const bool accepted = session->Copy(request, [&] { return cancel_requested.load(); },
      [&](const FileTransferProgress& progress) {
        if (progress.owned_destination) {
          last_progress_witness = *progress.owned_destination;
          have_progress_witness = true;
        }
        if (*saw_progress || progress.total == 0 || progress.transferred >= progress.total || !progress.owned_destination) return;
        *saw_progress = true;
        *total = progress.total;
        if (cancel) {
          cancel_requested.store(true);
          session->RequestCancel();
        }
      }, &result);
  if (accepted) session->FinishCopy();
  session->Shutdown();
  session->AwaitStopped();
  if (!accepted) throw ERROR_BUSY;
  return result;
}
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return 2;
  const std::wstring root = argv[1];
  const std::wstring cancel_source = root + L"\\cancel-source.bin";
  const std::wstring cancel_target = root + L"\\cancel-target.bin";
  if (!WriteSource(cancel_source) || !TargetMissing(cancel_target)) return 3;

  bool cancel_progress = false;
  uint64_t cancel_total = 0;
  FileTransferResult cancelled;
  try { cancelled = CopyAndCancel(cancel_source, cancel_target, root, true, &cancel_progress, &cancel_total); }
  catch (...) { return 4; }
  const bool cancel_source_intact = SourceIsIntact(cancel_source);
  const bool cancel_target_missing = TargetMissing(cancel_target);
  const bool cancel_target_valid = cancelled.status == FileTransferStatus::kUnchanged && cancel_target_missing && !cancelled.owned_destination;
  DeleteFileW(cancel_source.c_str());

  const std::wstring mutation_source = root + L"\\mutation-source.bin";
  const std::wstring mutation_target = root + L"\\mutation-target.bin";
  if (!WriteSource(mutation_source) || !TargetMissing(mutation_target)) return 5;
  active_target_path = mutation_target;
  mutation_applied.store(false);
  mutation_was_same_inode.store(false);
  mutation_error.store(ERROR_SUCCESS);
  mutate_before_path_check.store(true);
  bool mutation_progress = false;
  uint64_t mutation_total = 0;
  FileTransferResult changed;
  try { changed = CopyAndCancel(mutation_source, mutation_target, root, false, &mutation_progress, &mutation_total); }
  catch (...) { return 6; }
  const bool mutation_source_intact = SourceIsIntact(mutation_source);
  const bool mutation_target_exists = !TargetMissing(mutation_target);
  bool mutation_byte_changed = false;
  if (mutation_target_exists) {
    HANDLE file = CreateFileW(mutation_target.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file != INVALID_HANDLE_VALUE) {
      unsigned char byte = 0;
      DWORD read = 0;
      mutation_byte_changed = ReadFile(file, &byte, 1, &read, nullptr) != FALSE && read == 1 && byte == 0xa5;
      CloseHandle(file);
    }
  }
  const bool mutation_no_witness = changed.status == FileTransferStatus::kUnknown && !changed.owned_destination;
  const bool mutation_valid = mutation_applied.load() && mutation_was_same_inode.load() && mutation_target_exists &&
      mutation_byte_changed && mutation_no_witness && mutation_error.load() == ERROR_SUCCESS;

  std::printf("cancel progress=%u total=%llu cancelled=%u status=%u source_intact=%u target_missing=%u target_valid=%u\n",
      cancel_progress ? 1U : 0U, static_cast<unsigned long long>(cancel_total), cancelled.cancelled ? 1U : 0U,
      static_cast<unsigned>(cancelled.status), cancel_source_intact ? 1U : 0U, cancel_target_missing ? 1U : 0U,
      cancel_target_valid ? 1U : 0U);
  std::printf("mutation progress=%u total=%llu status=%u applied=%u same_inode=%u byte_changed=%u source_intact=%u target_exists=%u no_witness=%u error=%lu\n",
      mutation_progress ? 1U : 0U, static_cast<unsigned long long>(mutation_total), static_cast<unsigned>(changed.status),
      mutation_applied.load() ? 1U : 0U, mutation_was_same_inode.load() ? 1U : 0U, mutation_byte_changed ? 1U : 0U,
      mutation_source_intact ? 1U : 0U, mutation_target_exists ? 1U : 0U, mutation_no_witness ? 1U : 0U,
      mutation_error.load());

  DeleteFileW(mutation_source.c_str());
  if (mutation_target_exists && mutation_no_witness) DeleteFileW(mutation_target.c_str());
  return cancel_progress && cancel_total == kSourceBytes && cancelled.cancelled && cancel_source_intact &&
      cancel_target_valid && mutation_progress && mutation_total == kSourceBytes && mutation_source_intact && mutation_valid ? 0 : 7;
}

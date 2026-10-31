#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <atomic>
#include <cstdio>
#include <cwchar>
#include <functional>
#include <string>
#include <thread>
#include "../native/src/file-transfer-win.h"

namespace {
struct ReadState {
  std::atomic<bool> entered{false};
  std::atomic<bool> returned{false};
  std::atomic<DWORD> error{ERROR_SUCCESS};
};
HANDLE pipe_reader = INVALID_HANDLE_VALUE;
std::atomic<bool> validation_block{false};
std::atomic<bool> validation_entered{false};
std::atomic<bool> validation_read_returned{false};
std::atomic<DWORD> validation_read_error{ERROR_SUCCESS};
std::wstring validation_source;
HANDLE WINAPI TestCreateFileW(LPCWSTR path, DWORD access, DWORD share, LPSECURITY_ATTRIBUTES security,
                              DWORD creation, DWORD flags, HANDLE template_file);
void WaitFor(const std::atomic<bool>& value, DWORD timeout) {
  const ULONGLONG deadline = GetTickCount64() + timeout;
  while (!value.load() && GetTickCount64() < deadline) Sleep(1);
}
std::function<void(const FileTransferProgress&)> BlockInPipe(ReadState* state) {
  return [state](const FileTransferProgress&) {
    if (state->entered.exchange(true)) return;
    char value = 0;
    DWORD received = 0;
    const BOOL ok = ReadFile(pipe_reader, &value, 1, &received, nullptr);
    state->error.store(ok ? ERROR_SUCCESS : GetLastError());
    state->returned.store(true);
  };
}
}

#define CreateFileW TestCreateFileW
#include "../native/src/file-transfer-win.cc"
#undef CreateFileW

namespace {
HANDLE WINAPI TestCreateFileW(LPCWSTR path, DWORD access, DWORD share, LPSECURITY_ATTRIBUTES security,
                              DWORD creation, DWORD flags, HANDLE template_file) {
  if (validation_block.load() && path && Extended(validation_source) == path) {
    validation_entered.store(true);
    char value = 0;
    DWORD received = 0;
    const BOOL ok = ReadFile(pipe_reader, &value, 1, &received, nullptr);
    validation_read_error.store(ok ? ERROR_SUCCESS : GetLastError());
    validation_read_returned.store(true);
    if (!ok && validation_read_error.load() == ERROR_OPERATION_ABORTED) {
      SetLastError(ERROR_OPERATION_ABORTED);
      return INVALID_HANDLE_VALUE;
    }
  }
  return ::CreateFileW(path, access, share, security, creation, flags, template_file);
}
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return 2;
  const std::wstring root = argv[1];
  const std::wstring source_path = root + L"\\source.bin";
  validation_source = source_path;
  const std::wstring first_target = root + L"\\first-target.bin";
  const std::wstring second_target = root + L"\\second-target.bin";
  const std::wstring validation_target = root + L"\\validation-target.bin";
  const std::wstring pipe_name = L"\\\\.\\pipe\\copy-sync-cancel-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
  HANDLE pipe_writer = INVALID_HANDLE_VALUE;
  pipe_reader = CreateNamedPipeW(pipe_name.c_str(), PIPE_ACCESS_INBOUND, PIPE_TYPE_BYTE | PIPE_WAIT, 1, 4096, 4096, 0, nullptr);
  if (pipe_reader == INVALID_HANDLE_VALUE) return 3;
  pipe_writer = CreateFileW(pipe_name.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (pipe_writer == INVALID_HANDLE_VALUE) { CloseHandle(pipe_reader); return 4; }
  if (ConnectNamedPipe(pipe_reader, nullptr) || GetLastError() == ERROR_PIPE_CONNECTED) {}
  else { CloseHandle(pipe_writer); CloseHandle(pipe_reader); return 5; }

  HANDLE source = CreateFileW(source_path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (source == INVALID_HANDLE_VALUE) { CloseHandle(pipe_writer); CloseHandle(pipe_reader); return 6; }
  std::string bytes(8 * 1024 * 1024, 'C');
  DWORD written = 0;
  const bool source_ready = WriteFile(source, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) && written == bytes.size();
  CloseHandle(source);
  if (!source_ready) { CloseHandle(pipe_writer); CloseHandle(pipe_reader); DeleteFileW(source_path.c_str()); return 7; }

  FileTransferRequest request;
  request.source = source_path;
  request.roots = {root};
  { Handle handle = Open(source_path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    request.expected_source = Identity(handle.value).reported; }
  auto session = CreateNativeFileTransferSession();
  FileTransferRequest first_request = request;
  first_request.target = first_target;
  FileTransferRequest second_request = request;
  second_request.target = second_target;
  FileTransferRequest validation_request = request;
  validation_request.target = validation_target;
  FileTransferResult first_result, second_result, validation_result;
  ReadState first_read, second_read;
  std::atomic<bool> first_cancel_requested{false}, second_cancel_requested{false}, validation_cancel_requested{false};
  std::atomic<bool> first_finished{false}, worker_finished{false};
  std::atomic<bool> validation_finished{false};
  std::thread worker([&] {
    if (session->Copy(first_request, [&] { return first_cancel_requested.load(); }, BlockInPipe(&first_read), &first_result, 101)) session->FinishCopy();
    first_finished.store(true);
    if (session->Copy(second_request, [&] { return second_cancel_requested.load(); }, BlockInPipe(&second_read), &second_result, 102)) session->FinishCopy();
    worker_finished.store(false);
    validation_block.store(true);
    if (session->Copy(validation_request, [&] { return validation_cancel_requested.load(); }, {}, &validation_result, 103)) session->FinishCopy();
    validation_block.store(false);
    validation_finished.store(true);
    worker_finished.store(true);
  });
  WaitFor(first_read.entered, 5000);
  if (first_read.entered.load()) {
    first_cancel_requested.store(true);
    session->RequestCancel();
    session->RequestIoCancel(101);
    WaitFor(first_read.returned, 2000);
  }
  const bool first_cancelled_read = first_read.returned.load() && first_read.error.load() == ERROR_OPERATION_ABORTED;
  if (!first_read.returned.load()) { char release = 1; DWORD released = 0; WriteFile(pipe_writer, &release, 1, &released, nullptr); }
  WaitFor(first_finished, 5000);
  WaitFor(second_read.entered, 5000);
  bool stale_left_second_read_pending = false;
  if (second_read.entered.load()) {
    session->RequestIoCancel(101);
    Sleep(200);
    stale_left_second_read_pending = !second_read.returned.load() && !worker_finished.load();
    second_cancel_requested.store(true);
    session->RequestCancel();
    session->RequestIoCancel(102);
    WaitFor(second_read.returned, 2000);
  }
  const bool second_cancelled_read = second_read.returned.load() && second_read.error.load() == ERROR_OPERATION_ABORTED;
  if (!second_read.returned.load()) { char release = 1; DWORD released = 0; WriteFile(pipe_writer, &release, 1, &released, nullptr); }
  WaitFor(validation_entered, 5000);
  if (validation_entered.load()) {
    validation_cancel_requested.store(true);
    session->RequestCancel();
    session->RequestIoCancel(103);
    WaitFor(validation_read_returned, 2000);
  }
  const bool validation_cancelled_read = validation_read_returned.load() && validation_read_error.load() == ERROR_OPERATION_ABORTED;
  if (!validation_read_returned.load()) { char release = 1; DWORD released = 0; WriteFile(pipe_writer, &release, 1, &released, nullptr); }
  worker.join();
  session->Shutdown();
  const auto missing = [](const std::wstring& path) {
    SetLastError(ERROR_SUCCESS);
    return GetFileAttributesW(path.c_str()) == INVALID_FILE_ATTRIBUTES && GetLastError() == ERROR_FILE_NOT_FOUND;
  };
  const bool source_unchanged = [&] {
    HANDLE check = CreateFileW(source_path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (check == INVALID_HANDLE_VALUE) return false;
    std::string observed(bytes.size(), '\0');
    DWORD received = 0;
    const bool ok = ReadFile(check, observed.data(), static_cast<DWORD>(observed.size()), &received, nullptr) && received == observed.size() && observed == bytes;
    CloseHandle(check);
    return ok;
  }();
  const bool first_unchanged = first_result.status == FileTransferStatus::kUnchanged && first_result.cancelled;
  const bool second_unchanged = second_result.status == FileTransferStatus::kUnchanged && second_result.cancelled;
  const bool first_missing = missing(first_target);
  const bool second_missing = missing(second_target);
  const bool validation_missing = missing(validation_target);
  std::printf("first_callback=%u first_io_cancel=%u first_unchanged=%u second_callback=%u stale_safe=%u second_io_cancel=%u second_unchanged=%u validation_io_cancel=%u validation_cancelled=%u targets_missing=%u source_unchanged=%u\n",
              first_read.entered.load() ? 1u : 0u, first_cancelled_read ? 1u : 0u, first_unchanged ? 1u : 0u,
              second_read.entered.load() ? 1u : 0u, stale_left_second_read_pending ? 1u : 0u,
              second_cancelled_read ? 1u : 0u, second_unchanged ? 1u : 0u, validation_cancelled_read ? 1u : 0u,
              validation_result.cancelled ? 1u : 0u, first_missing && second_missing && validation_missing ? 1u : 0u,
              source_unchanged ? 1u : 0u);
  CloseHandle(pipe_writer);
  CloseHandle(pipe_reader);
  DeleteFileW(first_target.c_str());
  DeleteFileW(second_target.c_str());
  DeleteFileW(validation_target.c_str());
  DeleteFileW(source_path.c_str());
  return first_read.entered.load() && first_cancelled_read && first_unchanged && first_missing &&
      second_read.entered.load() && stale_left_second_read_pending && second_cancelled_read && second_unchanged &&
      second_missing && validation_entered.load() && validation_cancelled_read && validation_result.cancelled &&
      validation_result.status == FileTransferStatus::kUnchanged && validation_missing && source_unchanged ? 0 : 8;
}

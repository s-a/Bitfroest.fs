#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <atomic>
#include <cstdio>
#include <thread>

namespace {
std::atomic<bool> entered{false};
std::atomic<bool> observed_cancel{false};
BOOL WINAPI CopyWithoutProgress(LPCWSTR, LPCWSTR, LPPROGRESS_ROUTINE, LPVOID, LPBOOL cancel, DWORD) {
  entered.store(true);
  const ULONGLONG deadline = GetTickCount64() + 1000;
  while (GetTickCount64() < deadline) {
    if (InterlockedCompareExchange(reinterpret_cast<volatile LONG*>(cancel), 0, 0)) {
      observed_cancel.store(true);
      SetLastError(ERROR_REQUEST_ABORTED);
      return FALSE;
    }
    Sleep(1);
  }
  SetLastError(ERROR_TIMEOUT);
  return FALSE;
}
}

#define CopyFileExW CopyWithoutProgress
#include "../native/src/file-transfer-win.cc"
#undef CopyFileExW

int wmain(int argc, wchar_t** argv) {
  if (argc < 2 || argc > 3) return 2;
  const std::wstring root = argv[1], source_path = root + L"\\cancel-source.txt", target = root + L"\\cancel-target.txt";
  HANDLE source = CreateFileW(source_path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (source == INVALID_HANDLE_VALUE) return 3;
  DWORD written = 0;
  const bool prepared = WriteFile(source, "fixture", 7, &written, nullptr) && written == 7;
  CloseHandle(source);
  if (!prepared) return 4;
  FileTransferRequest request;
  request.source = source_path; request.target = target; request.roots = {root};
  { Handle handle = Open(source_path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    request.expected_source = Identity(handle.value).reported; }
  auto session = CreateNativeFileTransferSession();
  FileTransferResult result;
  std::thread worker([&] { if (session->Copy(request, [] { return false; }, {}, &result)) session->FinishCopy(); });
  const ULONGLONG deadline = GetTickCount64() + 2000;
  while (!entered.load() && GetTickCount64() < deadline) Sleep(1);
  if (argc == 3) session->RequestCancel(); else session->Shutdown();
  session->AwaitStopped();
  worker.join();
  session->Shutdown();
  DeleteFileW(source_path.c_str());
  std::printf("entered=%u cancel=%u unchanged=%u\n", entered.load() ? 1u : 0u,
              observed_cancel.load() ? 1u : 0u, result.status == FileTransferStatus::kUnchanged ? 1u : 0u);
  return entered.load() && observed_cancel.load() && result.status == FileTransferStatus::kUnchanged ? 0 : 5;
}

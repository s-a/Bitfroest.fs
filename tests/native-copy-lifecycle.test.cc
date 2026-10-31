#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <atomic>
#include <cstdio>
#include <thread>
#include "../native/src/file-transfer-win.h"

int wmain() {
  auto session = CreateNativeFileTransferSession();
  if (!session->RegisterQueuedCopy()) return 2;
  session->Shutdown();

  FileTransferResult result;
  std::atomic<bool> copy_returned{false};
  std::atomic<bool> allow_completion{false};
  std::atomic<bool> close_returned{false};
  std::thread copy([&] {
    const bool entered = session->Copy({}, [] { return false; }, {}, &result);
    copy_returned.store(entered);
    while (!allow_completion.load()) Sleep(1);
    if (entered) session->FinishCopy();
  });

  const ULONGLONG copy_deadline = GetTickCount64() + 2000;
  while (!copy_returned.load() && GetTickCount64() < copy_deadline) Sleep(1);
  if (!copy_returned.load()) {
    allow_completion.store(true);
    copy.join();
    return 3;
  }

  std::thread close([&] {
    session->AwaitStopped();
    close_returned.store(true);
  });
  Sleep(50);
  const bool waited_for_completion = !close_returned.load();
  allow_completion.store(true);
  copy.join();
  close.join();

  const bool expected_closed_result = result.status == FileTransferStatus::kUnchanged && result.cancelled;
  std::printf("queued=%u close_waited=%u closed_result=%u\n", copy_returned.load() ? 1u : 0u,
              waited_for_completion ? 1u : 0u, expected_closed_result ? 1u : 0u);
  if (!waited_for_completion || !expected_closed_result) return 4;

  auto busy_session = CreateNativeFileTransferSession();
  FileTransferResult first_result, rejected_result;
  const bool first_accepted = busy_session->Copy({}, [] { return false; }, {}, &first_result);
  if (!first_accepted || !busy_session->RegisterQueuedCopy() || !busy_session->RegisterQueuedCopy()) return 5;
  const bool second_accepted = busy_session->Copy({}, [] { return false; }, {}, &rejected_result);
  busy_session->CancelQueuedCopy();
  busy_session->FinishCopy();
  std::atomic<bool> busy_close_returned{false};
  std::thread busy_close([&] {
    busy_session->AwaitStopped();
    busy_close_returned.store(true);
  });
  Sleep(50);
  const bool retained_rejected_registration = !busy_close_returned.load();
  busy_session->CancelQueuedCopy();
  busy_close.join();
  std::printf("second_accepted=%u retained_queue=%u\n", second_accepted ? 1u : 0u,
              retained_rejected_registration ? 1u : 0u);
  return !second_accepted && retained_rejected_registration ? 0 : 6;
}

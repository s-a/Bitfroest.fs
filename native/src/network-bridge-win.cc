#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winnetwk.h>
#include "network-bridge-win.h"
#include <cstdint>
#include <vector>

namespace {
constexpr DWORD kMaxBuffer = 1024 * 1024;
std::wstring Resolve(const std::wstring& drive) {
  DWORD size = 512;
  for (unsigned int attempt = 0; attempt < 8 && size > 0 && size <= kMaxBuffer; ++attempt) {
    const DWORD allocated = size;
    std::vector<unsigned char> buffer(allocated);
    const DWORD status = WNetGetUniversalNameW((drive + L"\\").c_str(), UNIVERSAL_NAME_INFO_LEVEL,
                                               buffer.data(), &size);
    if (status == ERROR_MORE_DATA) continue;
    if (status != NO_ERROR || allocated < sizeof(UNIVERSAL_NAME_INFOW)) return {};
    const auto* info = reinterpret_cast<const UNIVERSAL_NAME_INFOW*>(buffer.data());
    const uintptr_t start = reinterpret_cast<uintptr_t>(buffer.data());
    const uintptr_t pointer = reinterpret_cast<uintptr_t>(info->lpUniversalName);
    if (pointer < start || pointer >= start + allocated || (pointer - start) % alignof(wchar_t)) return {};
    const size_t available = (start + allocated - pointer) / sizeof(wchar_t);
    size_t length = 0;
    while (length < available && info->lpUniversalName[length] != L'\0') ++length;
    if (length == available || length > 32767) return {};
    return std::wstring(info->lpUniversalName, length);
  }
  return {};
}
}
bool ResolveNetworkMappings(const std::vector<std::wstring>& drives,
                            std::vector<std::wstring>* mappings, DWORD* native_error) {
  if (native_error) *native_error = ERROR_SUCCESS;
  if (!mappings || drives.size() > 26) {
    if (native_error) *native_error = ERROR_INVALID_PARAMETER;
    return false;
  }
  for (const auto& drive : drives) {
    if (drive.size() != 2 || drive[0] < L'A' || drive[0] > L'Z' || drive[1] != L':') {
      if (native_error) *native_error = ERROR_INVALID_PARAMETER;
      return false;
    }
  }
  try {
    std::vector<std::wstring> result;
    result.reserve(drives.size());
    for (const auto& drive : drives) result.push_back(Resolve(drive));
    *mappings = std::move(result);
    return true;
  } catch (...) {
    if (native_error) *native_error = ERROR_NOT_ENOUGH_MEMORY;
    return false;
  }
}

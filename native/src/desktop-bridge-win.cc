#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <shlwapi.h>
#include <objbase.h>
#include <shlobj.h>
#include <knownfolders.h>
#include "desktop-bridge-win.h"
#include <vector>

namespace {
struct Apartment {
  HRESULT status = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  ~Apartment() { if (SUCCEEDED(status)) CoUninitialize(); }
};
bool AssociationIsEditor(const std::wstring& path) {
  const size_t separator = path.find_last_of(L"\\/");
  const size_t dot = path.find_last_of(L'.');
  if (dot == std::wstring::npos || (separator != std::wstring::npos && dot <= separator)) return false;
  std::vector<wchar_t> executable(32768);
  DWORD length = static_cast<DWORD>(executable.size());
  if (AssocQueryStringW(ASSOCF_NONE, ASSOCSTR_EXECUTABLE, path.substr(dot).c_str(), nullptr,
                        executable.data(), &length) != S_OK || !executable[0]) return false;
  const std::wstring value(executable.data());
  const size_t slash = value.find_last_of(L"\\/");
  const auto name = value.substr(slash == std::wstring::npos ? 0 : slash + 1);
  return _wcsicmp(name.c_str(), L"Code.exe") == 0 || _wcsicmp(name.c_str(), L"Code - Insiders.exe") == 0;
}
}

bool ResolveDesktopAssociation(const std::wstring& path, bool inspect_only,
                               DesktopAssociationResult* result, DWORD* native_error,
                               const std::atomic<bool>* closed) {
  if (native_error) *native_error = ERROR_SUCCESS;
  const auto fail = [native_error](DWORD error) { if (native_error) *native_error = error; return false; };
  if (closed && closed->load()) return fail(ERROR_CANCELLED);
  if (!result || path.empty() || path.size() > 32764 || path.find(L'\0') != std::wstring::npos) return fail(ERROR_INVALID_PARAMETER);
  const bool drive = path.size() >= 3 && ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) &&
      path[1] == L':' && (path[2] == L'\\' || path[2] == L'/');
  const bool unc = path.size() >= 5 && path[0] == L'\\' && path[1] == L'\\';
  if (!drive && !unc) return fail(ERROR_INVALID_PARAMETER);
  result->editor = false;
  const DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES) return fail(GetLastError());
  if (attributes & FILE_ATTRIBUTE_DIRECTORY) return fail(ERROR_DIRECTORY);
  Apartment apartment;
  if (FAILED(apartment.status)) return fail(ERROR_INVALID_STATE);
  result->editor = AssociationIsEditor(path);
  if (closed && closed->load()) return fail(ERROR_CANCELLED);
  if (inspect_only || result->editor) return true;
  const size_t separator = path.find_last_of(L"\\/");
  const std::wstring directory = separator == std::wstring::npos ? L"" : path.substr(0, separator + 1);
  SHELLEXECUTEINFOW info{};
  info.cbSize = sizeof(info);
  info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
  info.lpVerb = L"open";
  info.lpFile = path.c_str();
  info.lpDirectory = directory.c_str();
  info.nShow = SW_SHOWNORMAL;
  if (!ShellExecuteExW(&info)) return fail(GetLastError());
  if (info.hProcess) CloseHandle(info.hProcess);
  return true;
}

bool OpenDesktopTerminal(const std::wstring& path, bool inspect_only, std::wstring* parameters,
                         const std::atomic<bool>& closed, DWORD* native_error) {
  const auto fail = [native_error](DWORD error) { if (native_error) *native_error = error; return false; };
  if (closed.load()) return fail(ERROR_CANCELLED);
  if (path.empty() || path.find_first_of(L"\"\r\n") != std::wstring::npos) return fail(ERROR_INVALID_PARAMETER);
  const DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES) return fail(GetLastError());
  if (!(attributes & FILE_ATTRIBUTE_DIRECTORY)) return fail(ERROR_DIRECTORY);
  std::wstring escaped;
  for (const wchar_t character : path) {
    if (character == L';') escaped += L'\\';
    escaped += character;
  }
  size_t trailing = 0;
  for (size_t i = escaped.size(); i && escaped[i - 1] == L'\\'; --i) ++trailing;
  escaped.append(trailing, L'\\');
  *parameters = L"-w 0 nt -p \"Windows PowerShell\" -d \"" + escaped + L"\"";
  if (inspect_only) return true;
  Apartment apartment;
  if (FAILED(apartment.status)) return fail(ERROR_INVALID_STATE);
  PWSTR local = nullptr;
  const HRESULT status = SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_DONT_VERIFY, nullptr, &local);
  if (FAILED(status)) return fail(HRESULT_CODE(status));
  const std::wstring executable = std::wstring(local) + L"\\Microsoft\\WindowsApps\\wt.exe";
  CoTaskMemFree(local);
  if (closed.load()) return fail(ERROR_CANCELLED);
  SHELLEXECUTEINFOW info{};
  info.cbSize = sizeof(info);
  info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
  info.lpVerb = L"open";
  info.lpFile = executable.c_str();
  info.lpParameters = parameters->c_str();
  info.lpDirectory = path.c_str();
  info.nShow = SW_SHOWNORMAL;
  if (!ShellExecuteExW(&info)) return fail(GetLastError());
  if (info.hProcess) CloseHandle(info.hProcess);
  return true;
}

bool ResolveTrashView(bool inspect_only, const std::atomic<bool>& closed, DWORD* native_error) {
  if (native_error) *native_error = ERROR_SUCCESS;
  const auto fail = [native_error](DWORD error) { if (native_error) *native_error = error; return false; };
  if (closed.load()) return fail(ERROR_CANCELLED);
  Apartment apartment;
  if (FAILED(apartment.status)) return fail(ERROR_INVALID_STATE);
  PIDLIST_ABSOLUTE location = nullptr;
  const HRESULT status = SHGetKnownFolderIDList(FOLDERID_RecycleBinFolder, 0, nullptr, &location);
  if (FAILED(status)) return fail(HRESULT_CODE(status));
  if (closed.load()) { CoTaskMemFree(location); return fail(ERROR_CANCELLED); }
  if (inspect_only) { CoTaskMemFree(location); return true; }
  SHELLEXECUTEINFOW info{};
  info.cbSize = sizeof(info);
  info.fMask = SEE_MASK_IDLIST | SEE_MASK_NOASYNC | SEE_MASK_NOCLOSEPROCESS;
  info.lpIDList = location;
  info.lpVerb = L"open";
  info.nShow = SW_SHOWNORMAL;
  const BOOL result = ShellExecuteExW(&info);
  const DWORD error = result ? ERROR_SUCCESS : GetLastError();
  if (info.hProcess) CloseHandle(info.hProcess);
  CoTaskMemFree(location);
  return result ? true : fail(error);
}

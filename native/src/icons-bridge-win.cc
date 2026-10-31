#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objidl.h>
#include <shlobj.h>
#include <shellapi.h>
#include <gdiplus.h>
#include <algorithm>
#include <cstdint>
#include <climits>
#include <cwchar>
#include <string>
#include <vector>
#include "icons-bridge-win.h"

namespace {
constexpr uint32_t kMaxPngBytes = 65536;
constexpr uint64_t kMaxResourceBytes = 268435456;
using Request = FilesystemIconRequest;

struct IconHandle {
  HICON value = nullptr;
  ~IconHandle() { if (value) DestroyIcon(value); }
  IconHandle() = default;
  IconHandle(const IconHandle&) = delete;
  IconHandle& operator=(const IconHandle&) = delete;
};

struct StreamHandle {
  IStream* value = nullptr;
  ~StreamHandle() { if (value) value->Release(); }
  StreamHandle() = default;
  StreamHandle(const StreamHandle&) = delete;
  StreamHandle& operator=(const StreamHandle&) = delete;
};

struct ComApartment {
  HRESULT result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  ~ComApartment() { if (SUCCEEDED(result)) CoUninitialize(); }
};

struct GdiPlusSession {
  ULONG_PTR token = 0;
  Gdiplus::GdiplusStartupInput input;
  Gdiplus::Status result = Gdiplus::GdiplusStartup(&token, &input, nullptr);
  ~GdiPlusSession() { if (result == Gdiplus::Ok) Gdiplus::GdiplusShutdown(token); }
};

uint16_t Get16(const unsigned char* bytes) {
  return static_cast<uint16_t>(bytes[0] | (static_cast<uint16_t>(bytes[1]) << 8));
}
std::wstring Trim(std::wstring value) {
  const size_t first = value.find_first_not_of(L" \t\r\n");
  if (first == std::wstring::npos) return {};
  const size_t last = value.find_last_not_of(L" \t\r\n");
  value = value.substr(first, last - first + 1);
  if (value.size() >= 2 && value.front() == L'"' && value.back() == L'"') value = value.substr(1, value.size() - 2);
  return value;
}

bool IsLocalAbsolute(const std::wstring& path) {
  return path.size() >= 3 && ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) &&
         path[1] == L':' && (path[2] == L'\\' || path[2] == L'/');
}

bool Expand(std::wstring value, std::wstring* expanded) {
  const DWORD needed = ExpandEnvironmentStringsW(value.c_str(), nullptr, 0);
  if (!needed || needed > 32767) return false;
  std::vector<wchar_t> buffer(needed);
  const DWORD written = ExpandEnvironmentStringsW(value.c_str(), buffer.data(), needed);
  if (!written || written > needed) return false;
  expanded->assign(buffer.data(), written - 1);
  return true;
}

bool FullLocalPath(std::wstring value, const std::wstring& directory, bool resource,
                   std::wstring* output) {
  value = Trim(std::move(value));
  if (resource && !value.empty() && value.front() == L'@') value.erase(value.begin());
  if (value.empty() || value.size() > 4096 || value.find(L'\0') != std::wstring::npos ||
      value.front() == L'\\' || value.front() == L'/') return false;
  std::wstring expanded;
  if (!Expand(value, &expanded) || expanded.empty()) return false;
  if (!IsLocalAbsolute(expanded)) {
    if (directory.empty() || IsLocalAbsolute(expanded)) return false;
    expanded = directory + L"\\" + expanded;
  }
  std::vector<wchar_t> buffer(512);
  DWORD length = 0;
  while (buffer.size() <= 32768) {
    length = GetFullPathNameW(expanded.c_str(), static_cast<DWORD>(buffer.size()), buffer.data(), nullptr);
    if (!length) return false;
    if (length < buffer.size()) break;
    buffer.resize(static_cast<size_t>(length) + 1);
  }
  if (!length || length >= buffer.size()) return false;
  output->assign(buffer.data(), length);
  return IsLocalAbsolute(*output) && output->size() <= 32767;
}

bool ExistingNoReparse(const std::wstring& path, DWORD* attributes) {
  HANDLE handle = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                              OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (handle == INVALID_HANDLE_VALUE) return false;
  FILE_ATTRIBUTE_TAG_INFO info{};
  const bool ok = GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info)) != FALSE;
  CloseHandle(handle);
  if (!ok || (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
  if (attributes) *attributes = info.FileAttributes;
  return true;
}

bool ExistingOrMissingNoReparse(const std::wstring& path) {
  HANDLE handle = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                              OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (handle == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
  }
  FILE_ATTRIBUTE_TAG_INFO info{};
  const bool ok = GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info)) != FALSE;
  CloseHandle(handle);
  return ok && !(info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT);
}

bool SafeAncestors(const std::wstring& path) {
  if (!IsLocalAbsolute(path)) return false;
  std::wstring current = path.substr(0, 3);
  if (!ExistingNoReparse(current, nullptr)) return false;
  size_t position = 3;
  while (position < path.size()) {
    const size_t separator = path.find_first_of(L"\\/", position);
    const size_t end = separator == std::wstring::npos ? path.size() : separator;
    if (end > position) {
      current.append(path, position, end - position);
      if (!ExistingOrMissingNoReparse(current)) return false;
      if (separator != std::wstring::npos) current.push_back(L'\\');
    }
    if (separator == std::wstring::npos) break;
    position = separator + 1;
  }
  return true;
}

bool ReadSafeFile(const std::wstring& path, size_t limit, std::vector<unsigned char>* bytes) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  LARGE_INTEGER size{};
  const bool safe = GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes)) &&
                    !(attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
                    GetFileSizeEx(file, &size) && size.QuadPart >= 0 && static_cast<uint64_t>(size.QuadPart) <= limit;
  if (!safe) { CloseHandle(file); return false; }
  bytes->resize(static_cast<size_t>(size.QuadPart));
  size_t position = 0;
  while (position < bytes->size()) {
    DWORD count = 0;
    const DWORD requested = static_cast<DWORD>(std::min<size_t>(bytes->size() - position, 65536));
    if (!ReadFile(file, bytes->data() + position, requested, &count, nullptr) || !count) {
      CloseHandle(file);
      bytes->clear();
      return false;
    }
    position += count;
  }
  CloseHandle(file);
  return true;
}

std::wstring DecodeIni(const std::vector<unsigned char>& bytes) {
  if (bytes.size() >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe) {
    std::wstring text;
    text.reserve((bytes.size() - 2) / 2);
    for (size_t i = 2; i + 1 < bytes.size(); i += 2) text.push_back(static_cast<wchar_t>(Get16(bytes.data() + i)));
    return text;
  }
  if (bytes.size() >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff) {
    std::wstring text;
    text.reserve((bytes.size() - 2) / 2);
    for (size_t i = 2; i + 1 < bytes.size(); i += 2) {
      text.push_back(static_cast<wchar_t>((static_cast<uint16_t>(bytes[i]) << 8) | bytes[i + 1]));
    }
    return text;
  }
  UINT codepage = CP_ACP;
  size_t offset = 0;
  if (bytes.size() >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf) { codepage = CP_UTF8; offset = 3; }
  if (bytes.size() - offset > INT_MAX) return {};
  const int length = MultiByteToWideChar(codepage, 0, reinterpret_cast<const char*>(bytes.data() + offset),
                                         static_cast<int>(bytes.size() - offset), nullptr, 0);
  if (length <= 0) return {};
  std::wstring text(static_cast<size_t>(length), L'\0');
  if (!MultiByteToWideChar(codepage, 0, reinterpret_cast<const char*>(bytes.data() + offset),
                           static_cast<int>(bytes.size() - offset), text.data(), length)) return {};
  return text;
}

bool EqualInsensitive(const std::wstring& left, const wchar_t* right) {
  return CompareStringOrdinal(left.c_str(), -1, right, -1, TRUE) == CSTR_EQUAL;
}

std::wstring DesktopResource(const std::wstring& directory) {
  std::vector<unsigned char> bytes;
  if (!ReadSafeFile(directory + L"\\desktop.ini", 65536, &bytes)) return {};
  const std::wstring content = DecodeIni(bytes);
  std::wstring section, icon_resource, icon_file, icon_index;
  size_t position = 0;
  while (position <= content.size()) {
    const size_t end = content.find_first_of(L"\r\n", position);
    std::wstring line = Trim(content.substr(position, end == std::wstring::npos ? content.size() - position : end - position));
    if (line.size() >= 2 && line.front() == L'[' && line.back() == L']') {
      section = Trim(line.substr(1, line.size() - 2));
    } else if (EqualInsensitive(section, L".ShellClassInfo")) {
      const size_t equals = line.find(L'=');
      if (equals != std::wstring::npos && (line.empty() || line.front() != L';')) {
        const std::wstring key = Trim(line.substr(0, equals));
        const std::wstring value = Trim(line.substr(equals + 1));
        if (EqualInsensitive(key, L"IconResource")) icon_resource = value;
        else if (EqualInsensitive(key, L"IconFile")) icon_file = value;
        else if (EqualInsensitive(key, L"IconIndex")) icon_index = value;
      }
    }
    if (end == std::wstring::npos) break;
    position = end + 1;
    if (content[end] == L'\r' && position < content.size() && content[position] == L'\n') ++position;
  }
  if (!icon_resource.empty()) return icon_resource;
  if (icon_file.empty()) return {};
  return icon_file + L"," + (icon_index.empty() ? L"0" : icon_index);
}

bool ParseResource(std::wstring resource, const std::wstring& directory,
                   std::wstring* path, int* index) {
  resource = Trim(std::move(resource));
  if (resource.empty() || resource.size() > 4096) return false;
  const size_t comma = resource.find_last_of(L',');
  if (comma != std::wstring::npos) {
    const std::wstring suffix = Trim(resource.substr(comma + 1));
    if (!suffix.empty() && (suffix.front() == L'-' || (suffix.front() >= L'0' && suffix.front() <= L'9'))) {
      wchar_t* end = nullptr;
      const long parsed = wcstol(suffix.c_str(), &end, 10);
      if (!end || *end || parsed < -65535 || parsed > 65535) return false;
      *index = static_cast<int>(parsed);
      resource.resize(comma);
    }
  }
  if (!FullLocalPath(resource, directory, true, path) || !SafeAncestors(*path)) return false;
  DWORD attributes = 0;
  if (!ExistingNoReparse(*path, &attributes) || (attributes & FILE_ATTRIBUTE_DIRECTORY)) return false;
  HANDLE file = CreateFileW(path->c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER size{};
  const bool size_ok = GetFileSizeEx(file, &size) && size.QuadPart >= 0 && static_cast<uint64_t>(size.QuadPart) <= kMaxResourceBytes;
  CloseHandle(file);
  if (!size_ok) return false;
  const std::wstring extension = path->substr(path->find_last_of(L'.') == std::wstring::npos ? path->size() : path->find_last_of(L'.'));
  return EqualInsensitive(extension, L".ico") || EqualInsensitive(extension, L".exe") ||
         EqualInsensitive(extension, L".dll") || EqualInsensitive(extension, L".icl");
}

HICON ResourceIcon(const std::wstring& resource, const std::wstring& directory) {
  if (resource.empty()) return nullptr;
  std::wstring path;
  int index = 0;
  if (!ParseResource(resource, directory, &path, &index)) return nullptr;
  HANDLE resource_file = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
                                     FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                                     FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (resource_file == INVALID_HANDLE_VALUE) return nullptr;
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  LARGE_INTEGER size{};
  const bool safe = GetFileInformationByHandleEx(resource_file, FileAttributeTagInfo, &attributes, sizeof(attributes)) &&
                    !(attributes.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) &&
                    GetFileSizeEx(resource_file, &size) && size.QuadPart >= 0 &&
                    static_cast<uint64_t>(size.QuadPart) <= kMaxResourceBytes;
  if (!safe) { CloseHandle(resource_file); return nullptr; }
  HICON large_icons[1]{}, small_icons[1]{};
  const UINT count = ExtractIconExW(path.c_str(), index, large_icons, small_icons, 1);
  CloseHandle(resource_file);
  if (large_icons[0]) DestroyIcon(large_icons[0]);
  if (!count || !small_icons[0]) {
    if (small_icons[0]) DestroyIcon(small_icons[0]);
    return nullptr;
  }
  return small_icons[0];
}

HICON SystemIcon(const Request& request, const std::wstring& local_path, bool exists) {
  SHFILEINFOW info{};
  UINT flags = SHGFI_ICON | SHGFI_SMALLICON;
  std::wstring lookup = local_path;
  if (!exists) {
    flags |= SHGFI_USEFILEATTRIBUTES;
    lookup = request.name;
    const size_t separator = lookup.find_last_of(L"\\/");
    if (separator != std::wstring::npos) lookup.erase(0, separator + 1);
    if (lookup.empty()) lookup = request.folder ? L"folder" : L"file";
  }
  const DWORD attributes = request.folder ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL;
  if (!SHGetFileInfoW(lookup.c_str(), attributes, &info, sizeof(info), flags)) return nullptr;
  return info.hIcon;
}

bool EncodePng(HICON icon, std::vector<unsigned char>* output) {
  Gdiplus::Bitmap bitmap(icon);
  if (bitmap.GetLastStatus() != Gdiplus::Ok) return false;
  HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, 0);
  if (!memory) return false;
  StreamHandle stream;
  if (CreateStreamOnHGlobal(memory, TRUE, &stream.value) != S_OK) { GlobalFree(memory); return false; }
  static const CLSID png_encoder = {0x557cf406, 0x1a04, 0x11d3, {0x9a, 0x73, 0x00, 0x00, 0xf8, 0x1e, 0xf3, 0x2e}};
  if (bitmap.Save(stream.value, &png_encoder, nullptr) != Gdiplus::Ok) return false;
  STATSTG stat{};
  if (stream.value->Stat(&stat, STATFLAG_NONAME) != S_OK || stat.cbSize.HighPart ||
      stat.cbSize.LowPart < 8 || stat.cbSize.LowPart > kMaxPngBytes) return false;
  HGLOBAL saved = nullptr;
  if (GetHGlobalFromStream(stream.value, &saved) != S_OK) return false;
  const auto* bytes = static_cast<const unsigned char*>(GlobalLock(saved));
  if (!bytes) return false;
  output->assign(bytes, bytes + stat.cbSize.LowPart);
  GlobalUnlock(saved);
  return true;
}

void PumpMessages() {
  MSG message{};
  while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
}

std::vector<unsigned char> ResolveOne(const Request& request) {
  std::vector<unsigned char> png;
  std::wstring local_path;
  const bool normalized = FullLocalPath(request.path, {}, false, &local_path) && SafeAncestors(local_path);
  DWORD attributes = 0;
  bool exists = normalized && ExistingNoReparse(local_path, &attributes) &&
                ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) == request.folder;
  std::wstring directory;
  if (request.folder && exists) directory = local_path;
  else if (normalized) {
    const size_t separator = local_path.find_last_of(L"\\/");
    if (separator != std::wstring::npos) directory = local_path.substr(0, separator);
  }
  std::wstring resource = request.icon_resource;
  if (resource.empty() && request.folder && exists) resource = DesktopResource(local_path);
  IconHandle icon;
  icon.value = ResourceIcon(resource, directory);
  if (!icon.value) icon.value = SystemIcon(request, local_path, exists);
  if (!icon.value || !EncodePng(icon.value, &png)) return {};
  return png;
}
}

bool ResolveFilesystemIcons(const std::vector<FilesystemIconRequest>& requests,
                            std::vector<FilesystemIconResult>* results,
                            DWORD* native_error) {
  if (native_error) *native_error = ERROR_SUCCESS;
  if (!results) {
    if (native_error) *native_error = ERROR_INVALID_PARAMETER;
    return false;
  }
  results->clear();
  if (requests.size() > 24) {
    if (native_error) *native_error = ERROR_INVALID_PARAMETER;
    return false;
  }
  for (const auto& request : requests) {
    if (request.key.empty() || request.key.size() > 1200 || request.key.find('\0') != std::string::npos ||
        request.path.size() > 4096 || request.name.size() > 300 || request.icon_resource.size() > 4096 ||
        request.path.find(L'\0') != std::wstring::npos || request.name.find(L'\0') != std::wstring::npos ||
        request.icon_resource.find(L'\0') != std::wstring::npos) {
      if (native_error) *native_error = ERROR_INVALID_PARAMETER;
      return false;
    }
  }
  try {
    ComApartment apartment;
    if (FAILED(apartment.result)) {
      if (native_error) *native_error = ERROR_INVALID_STATE;
      return false;
    }
    GdiPlusSession graphics;
    if (graphics.result != Gdiplus::Ok) {
      if (native_error) *native_error = ERROR_GEN_FAILURE;
      return false;
    }
    results->reserve(requests.size());
    for (const auto& request : requests) {
      FilesystemIconResult result;
      result.key = request.key;
      try { result.png = ResolveOne(request); } catch (...) { result.png.clear(); }
      results->push_back(std::move(result));
      PumpMessages();
    }
    return true;
  } catch (const std::bad_alloc&) {
    results->clear();
    if (native_error) *native_error = ERROR_NOT_ENOUGH_MEMORY;
    return false;
  } catch (...) {
    results->clear();
    if (native_error) *native_error = ERROR_GEN_FAILURE;
    return false;
  }
}

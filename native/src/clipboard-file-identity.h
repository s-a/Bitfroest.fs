#pragma once
#include "clipboard-ole-engine.h"
#include <cstring>
#include <cwchar>

inline HRESULT ReadClipboardFileIdentity(HANDLE file, ClipboardFileIdentity* identity,
    decltype(&GetFileInformationByHandleEx) extended = &GetFileInformationByHandleEx,
    decltype(&GetFileInformationByHandle) basic = &GetFileInformationByHandle,
    decltype(&GetVolumeInformationByHandleW) volume = &GetVolumeInformationByHandleW) {
  *identity = {};
  FILE_ID_INFO info{};
  BY_HANDLE_FILE_INFORMATION attributes{};
  const BOOL id_ok = extended(file, FileIdInfo, &info, sizeof(info));
  const DWORD id_error = id_ok ? ERROR_SUCCESS : GetLastError();
  const BOOL basic_ok = basic(file, &attributes);
  const DWORD basic_error = basic_ok ? ERROR_SUCCESS : GetLastError();
  if (!id_ok && id_error != ERROR_INVALID_PARAMETER && id_error != ERROR_NOT_SUPPORTED && id_error != ERROR_INVALID_FUNCTION) return HRESULT_FROM_WIN32(id_error);
  if (!basic_ok) return HRESULT_FROM_WIN32(basic_error);
  if (id_ok) {
    identity->volume = info.VolumeSerialNumber;
    identity->id = info.FileId;
  } else {
    wchar_t filesystem[MAX_PATH + 1]{};
    if (!volume(file, nullptr, 0, nullptr, nullptr, nullptr, filesystem, MAX_PATH + 1)) return HRESULT_FROM_WIN32(GetLastError());
    if (_wcsicmp(filesystem, L"NTFS") || !attributes.dwVolumeSerialNumber || (!attributes.nFileIndexHigh && !attributes.nFileIndexLow)) return HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED);
    const ULONGLONG index = (static_cast<ULONGLONG>(attributes.nFileIndexHigh) << 32) | attributes.nFileIndexLow;
    identity->volume = attributes.dwVolumeSerialNumber;
    std::memcpy(identity->id.Identifier, &index, sizeof(index));
    identity->kind = ClipboardFileIdentity::Kind::FileIndex64;
  }
  identity->directory = (attributes.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  return S_OK;
}

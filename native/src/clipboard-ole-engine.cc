#include "clipboard-ole-engine.h"
#include <shellapi.h>
#include <shlobj.h>
#include <algorithm>
#include <cstdio>
#include <iterator>
#include <cstring>
#include <limits>

namespace {
constexpr HRESULT kClipboardChanged = HRESULT_FROM_WIN32(ERROR_RETRY);
constexpr HRESULT kSessionClosed = HRESULT_FROM_WIN32(ERROR_CANCELLED);

HRESULT CheckOpen(const ClipboardBackend* backend) {
  return backend->IsClosed() ? kSessionClosed : S_OK;
}

FORMATETC Format(CLIPFORMAT id) {
  return FORMATETC{ id, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL };
}

bool SamePath(const std::wstring& left, const std::wstring& right) {
  return CompareStringOrdinal(left.data(), static_cast<int>(left.size()), right.data(),
                              static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}

std::wstring NormalizePath(std::wstring value) {
  std::replace(value.begin(), value.end(), L'\\', L'/');
  return value;
}

bool SameIdentity(const ClipboardFileIdentity& left, const ClipboardFileIdentity& right) {
  return left.volume == right.volume && left.directory == right.directory &&
      std::memcmp(left.id.Identifier, right.id.Identifier, sizeof(left.id.Identifier)) == 0;
}

HRESULT ReadDropPaths(IDataObject* data, std::vector<std::wstring>* paths) {
  paths->clear();
  if (!data) return S_OK;
  FORMATETC format = Format(CF_HDROP);
  const HRESULT available = data->QueryGetData(&format);
  if (available == S_FALSE || available == DV_E_FORMATETC || available == DV_E_CLIPFORMAT || available == DV_E_TYMED) return S_OK;
  if (FAILED(available)) return available;
  STGMEDIUM medium{};
  HRESULT result = data->GetData(&format, &medium);
  if (FAILED(result)) return result;
  if (medium.tymed != TYMED_HGLOBAL || !medium.hGlobal) {
    ReleaseStgMedium(&medium);
    return DV_E_TYMED;
  }
  if (GlobalSize(medium.hGlobal) < sizeof(DROPFILES)) {
    ReleaseStgMedium(&medium);
    return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
  }
  HDROP drop = reinterpret_cast<HDROP>(medium.hGlobal);
  const UINT count = DragQueryFileW(drop, 0xffffffff, nullptr, 0);
  if (count > 1024) {
    ReleaseStgMedium(&medium);
    return HRESULT_FROM_WIN32(ERROR_BUFFER_OVERFLOW);
  }
  std::vector<std::wstring> unique;
  unique.reserve(count);
  for (UINT index = 0; index < count; ++index) {
    const UINT length = DragQueryFileW(drop, index, nullptr, 0);
    if (!length || length > 4096) {
      ReleaseStgMedium(&medium);
      return HRESULT_FROM_WIN32(ERROR_INVALID_NAME);
    }
    std::wstring path(static_cast<size_t>(length) + 1, L'\0');
    const UINT written = DragQueryFileW(drop, index, path.data(), length + 1);
    if (written != length) {
      ReleaseStgMedium(&medium);
      return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
    }
    path.resize(length);
    path = NormalizePath(std::move(path));
    if (std::find_if(unique.begin(), unique.end(), [&](const auto& item) { return SamePath(item, path); }) == unique.end()) unique.push_back(std::move(path));
  }
  ReleaseStgMedium(&medium);
  *paths = std::move(unique);
  return S_OK;
}

HRESULT ReadEffect(IDataObject* data, std::wstring* mode) {
  *mode = L"copy";
  if (!data) return S_OK;
  const CLIPFORMAT id = static_cast<CLIPFORMAT>(RegisterClipboardFormatW(L"Preferred DropEffect"));
  if (!id) return HRESULT_FROM_WIN32(GetLastError());
  FORMATETC format = Format(id);
  const HRESULT available = data->QueryGetData(&format);
  if (available == S_FALSE || available == DV_E_FORMATETC || available == DV_E_CLIPFORMAT || available == DV_E_TYMED) return S_OK;
  if (FAILED(available)) return available;
  STGMEDIUM medium{};
  HRESULT result = data->GetData(&format, &medium);
  if (FAILED(result)) return result;
  if (medium.tymed != TYMED_HGLOBAL || !medium.hGlobal) {
    ReleaseStgMedium(&medium);
    return DV_E_TYMED;
  }
  if (GlobalSize(medium.hGlobal) < sizeof(DWORD)) {
    ReleaseStgMedium(&medium);
    return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
  }
  const void* memory = GlobalLock(medium.hGlobal);
  if (!memory) {
    result = HRESULT_FROM_WIN32(GetLastError());
  } else {
    const DWORD effect = *static_cast<const DWORD*>(memory);
    if (effect == DROPEFFECT_COPY || effect == 0) *mode = L"copy";
    else if (effect == DROPEFFECT_MOVE) *mode = L"move";
    else if (effect == DROPEFFECT_LINK) *mode = L"link";
    else result = DV_E_FORMATETC;
    GlobalUnlock(medium.hGlobal);
  }
  ReleaseStgMedium(&medium);
  return result;
}

HRESULT Notify(IDataObject* data, const wchar_t* name, DWORD effect, std::vector<std::string>* errors) {
  const CLIPFORMAT id = static_cast<CLIPFORMAT>(RegisterClipboardFormatW(name));
  if (!id) return HRESULT_FROM_WIN32(GetLastError());
  HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, sizeof(effect));
  if (!memory) return HRESULT_FROM_WIN32(GetLastError());
  void* locked = GlobalLock(memory);
  if (!locked) {
    const DWORD error = GetLastError();
    GlobalFree(memory);
    return HRESULT_FROM_WIN32(error);
  }
  std::memcpy(locked, &effect, sizeof(effect));
  GlobalUnlock(memory);
  FORMATETC format = Format(id);
  STGMEDIUM medium{};
  medium.tymed = TYMED_HGLOBAL;
  medium.hGlobal = memory;
  const HRESULT result = data->SetData(&format, &medium, FALSE);
  ReleaseStgMedium(&medium);
  if (result == S_OK) return S_OK;
  if (result == E_NOTIMPL || result == DV_E_FORMATETC || result == E_FAIL) {
    char code[9]{};
    std::snprintf(code, sizeof(code), "%08X", static_cast<unsigned int>(result));
    std::wstring wide_name(name);
    std::string utf8;
    utf8.reserve(wide_name.size());
    for (const wchar_t character : wide_name) {
      if (character > 0x7f) return E_INVALIDARG;
      utf8.push_back(static_cast<char>(character));
    }
    errors->push_back(utf8 + ": 0x" + code);
    return S_OK;
  }
  return result;
}

HRESULT CreateToken(DWORD sequence, ULONGLONG serial, std::wstring* token) {
  GUID id{};
  const HRESULT result = CoCreateGuid(&id);
  if (FAILED(result)) return result;
  wchar_t uuid[40]{};
  if (!StringFromGUID2(id, uuid, static_cast<int>(std::size(uuid)))) return E_FAIL;
  wchar_t prefix[64]{};
  const int length = swprintf_s(prefix, L"%lu:%llu:", static_cast<unsigned long>(sequence), serial);
  if (length <= 0) return E_FAIL;
  token->assign(prefix, static_cast<size_t>(length));
  token->append(uuid);
  return S_OK;
}

bool ValidSubset(const std::vector<std::wstring>& original, const std::vector<std::wstring>& remaining) {
  size_t cursor = 0;
  for (const auto& value : remaining) {
    while (cursor < original.size() && !SamePath(original[cursor], value)) ++cursor;
    if (cursor == original.size()) return false;
    ++cursor;
  }
  return true;
}
}

ClipboardOleEngine::ClipboardOleEngine(ClipboardBackend* backend) : backend_(backend) {}

ClipboardOleEngine::~ClipboardOleEngine() { Reset(); }

void ClipboardOleEngine::Reset() {
  if (retained_) {
    retained_->Release();
    retained_ = nullptr;
  }
  sequence_ = 0;
  token_.clear();
  mode_.clear();
  entries_.clear();
}

HRESULT ClipboardOleEngine::ReadCurrent(IDataObject** data, DWORD* sequence, ClipboardSelection* selection,
                                        std::vector<Entry>* entries) {
  HRESULT result = CheckOpen(backend_);
  if (FAILED(result)) return result;
  const DWORD before = backend_->Sequence();
  IDataObject* current = nullptr;
  result = backend_->GetDataObject(&current);
  if (SUCCEEDED(result)) result = CheckOpen(backend_);
  if (FAILED(result)) { if (current) current->Release(); return result; }
  std::vector<std::wstring> paths;
  std::wstring mode;
  result = ReadDropPaths(current, &paths);
  if (SUCCEEDED(result)) result = CheckOpen(backend_);
  if (SUCCEEDED(result)) result = ReadEffect(current, &mode);
  if (SUCCEEDED(result)) result = CheckOpen(backend_);
  std::vector<Entry> snapshots;
  if (SUCCEEDED(result)) {
    snapshots.reserve(paths.size());
    for (const auto& path : paths) {
      ClipboardFileIdentity identity;
      result = backend_->GetIdentity(path, &identity);
      const HRESULT open = CheckOpen(backend_);
      if (FAILED(open)) result = open;
      if (FAILED(result)) break;
      snapshots.push_back({ path, identity });
    }
  }
  const DWORD after = backend_->Sequence();
  if (SUCCEEDED(result) && before != after) result = kClipboardChanged;
  if (FAILED(result)) {
    if (current) current->Release();
    return result;
  }
  selection->paths = paths;
  selection->mode = mode;
  selection->notification_errors.clear();
  *sequence = after;
  *data = current;
  *entries = std::move(snapshots);
  return S_OK;
}

HRESULT ClipboardOleEngine::Read(ClipboardSelection* selection) {
  if (!selection) return E_POINTER;
  Reset();
  IDataObject* current = nullptr;
  DWORD sequence = 0;
  std::vector<Entry> entries;
  HRESULT result = ReadCurrent(&current, &sequence, selection, &entries);
  if (FAILED(result)) return result;
  result = CreateToken(sequence, next_token_++, &selection->token);
  if (FAILED(result)) {
    if (current) current->Release();
    return result;
  }
  retained_ = current;
  sequence_ = sequence;
  token_ = selection->token;
  mode_ = selection->mode;
  entries_ = std::move(entries);
  return S_OK;
}

HRESULT ClipboardOleEngine::Write(const std::vector<std::wstring>& paths, const std::wstring& mode,
                                 ClipboardSelection* selection) {
  if (!selection) return E_POINTER;
  if (paths.empty() || paths.size() > 1024 || (mode != L"copy" && mode != L"move")) return E_INVALIDARG;
  HRESULT result = CheckOpen(backend_);
  if (FAILED(result)) return result;
  for (const auto& path : paths) {
    ClipboardFileIdentity identity;
    result = backend_->GetIdentity(path, &identity);
    const HRESULT open = CheckOpen(backend_);
    if (FAILED(open)) return open;
    if (FAILED(result)) return result;
  }
  result = CheckOpen(backend_);
  if (FAILED(result)) return result;
  Reset();
  result = backend_->Replace(paths, mode, false, 0);
  if (FAILED(result)) return result;
  result = CheckOpen(backend_);
  if (FAILED(result)) return result;
  return Read(selection);
}

HRESULT ClipboardOleEngine::Acknowledge(const std::wstring& token, const std::vector<std::wstring>& paths,
                                        const std::wstring& mode, const std::vector<std::wstring>& remaining,
                                        bool* matched, std::vector<std::string>* notification_errors) {
  if (!matched || !notification_errors) return E_POINTER;
  *matched = false;
  notification_errors->clear();
  HRESULT open = CheckOpen(backend_);
  if (FAILED(open)) return open;
  if (!retained_ || token.empty() || token != token_ || mode != mode_ || paths.size() != entries_.size() ||
      paths.empty() || !ValidSubset(paths, remaining)) return S_OK;
  for (size_t index = 0; index < paths.size(); ++index) {
    if (!SamePath(paths[index], entries_[index].path)) return S_OK;
  }
  if (backend_->Sequence() != sequence_) return S_OK;
  open = CheckOpen(backend_);
  if (FAILED(open)) return open;

  std::vector<std::wstring> held_paths;
  std::wstring held_mode;
  HRESULT result = ReadDropPaths(retained_, &held_paths);
  if (SUCCEEDED(result)) result = CheckOpen(backend_);
  if (SUCCEEDED(result)) result = ReadEffect(retained_, &held_mode);
  if (SUCCEEDED(result)) result = CheckOpen(backend_);
  if (FAILED(result)) return result;
  if (held_mode != mode_ || held_paths.size() != entries_.size()) return S_OK;
  for (size_t index = 0; index < held_paths.size(); ++index) {
    if (!SamePath(held_paths[index], entries_[index].path)) return S_OK;
  }

  size_t remaining_index = 0;
  for (size_t index = 0; index < entries_.size(); ++index) {
    const bool retained = remaining_index < remaining.size() && SamePath(entries_[index].path, remaining[remaining_index]);
    if (retained) {
      ClipboardFileIdentity current{};
      const HRESULT identity_result = backend_->GetIdentity(entries_[index].path, &current);
      if (FAILED(CheckOpen(backend_))) return kSessionClosed;
      if (FAILED(identity_result) || !SameIdentity(entries_[index].identity, current)) return S_OK;
      ++remaining_index;
    } else if (mode == L"move") {
      ClipboardFileIdentity current{};
      const HRESULT identity_result = backend_->GetIdentity(entries_[index].path, &current);
      if (FAILED(CheckOpen(backend_))) return kSessionClosed;
      if (SUCCEEDED(identity_result)) return S_OK;
      if (identity_result != HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) && identity_result != HRESULT_FROM_WIN32(ERROR_PATH_NOT_FOUND)) return identity_result;
    }
  }

  if (remaining.empty() && mode == L"move") {
    result = CheckOpen(backend_);
    if (FAILED(result)) return result;
    result = Notify(retained_, L"Performed DropEffect", DROPEFFECT_NONE, notification_errors);
    if (FAILED(result)) return result;
    result = CheckOpen(backend_);
    if (FAILED(result)) return result;
    result = Notify(retained_, L"Paste Succeeded", DROPEFFECT_MOVE, notification_errors);
    if (FAILED(result)) return result;
  }
  result = CheckOpen(backend_);
  if (FAILED(result)) return result;
  result = backend_->Replace(remaining, mode, true, sequence_);
  if (result == kClipboardChanged) return S_OK;
  if (FAILED(result)) return result;
  *matched = true;
  Reset();
  return S_OK;
}

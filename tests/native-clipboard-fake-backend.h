#pragma once
#include "../native/src/clipboard-ole-engine.h"
#include "../native/src/session.h"
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <objidl.h>
#include <algorithm>
#include <atomic>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

struct ClipboardTestOwnerGate {
  ClipboardTestOwnerGate() { entered = CreateEventW(nullptr, TRUE, FALSE, nullptr); release = CreateEventW(nullptr, TRUE, FALSE, nullptr); }
  ~ClipboardTestOwnerGate() { if (entered) CloseHandle(entered); if (release) CloseHandle(release); }
  HANDLE entered = nullptr;
  HANDLE release = nullptr;
  std::atomic<bool> closed{false};
  std::atomic<unsigned> waiting{0};
  unsigned required = 1;
};

inline std::mutex& ClipboardTestOwnerGateMutex() { static std::mutex value; return value; }
inline std::shared_ptr<ClipboardTestOwnerGate>& ClipboardTestOwnerGateValue() { static std::shared_ptr<ClipboardTestOwnerGate> value; return value; }
inline std::shared_ptr<ClipboardTestOwnerGate> CurrentClipboardTestOwnerGate() { std::lock_guard<std::mutex> lock(ClipboardTestOwnerGateMutex()); return ClipboardTestOwnerGateValue(); }
inline void SetClipboardTestOwnerGate(std::shared_ptr<ClipboardTestOwnerGate> value) { std::lock_guard<std::mutex> lock(ClipboardTestOwnerGateMutex()); ClipboardTestOwnerGateValue() = std::move(value); }

class ClipboardTestDataObject final : public IDataObject {
 public:
  ClipboardTestDataObject(std::vector<std::wstring> paths, DWORD effect, std::shared_ptr<ClipboardTestOwnerGate> gate = {}) : paths_(std::move(paths)), effect_(effect), gate_(std::move(gate)) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** output) override {
    if (!output) return E_POINTER;
    if (id == IID_IUnknown || id == IID_IDataObject) { *output = static_cast<IDataObject*>(this); AddRef(); return S_OK; }
    *output = nullptr; return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
  ULONG STDMETHODCALLTYPE Release() override { const ULONG left = --references_; if (!left) delete this; return left; }
  HRESULT STDMETHODCALLTYPE GetData(FORMATETC* format, STGMEDIUM* medium) override {
    if (!format || !medium) return E_POINTER;
    HGLOBAL memory = nullptr;
    if (format->cfFormat == CF_HDROP) {
      if (gate_ && !gate_->closed.load() && gate_->entered && gate_->release && WaitForSingleObject(gate_->release, 0) == WAIT_TIMEOUT) {
        const unsigned waiting = ++gate_->waiting;
        if (waiting >= gate_->required) SetEvent(gate_->entered);
        WaitForSingleObject(gate_->release, INFINITE);
      }
      std::vector<wchar_t> names;
      for (const auto& path : paths_) { names.insert(names.end(), path.begin(), path.end()); names.push_back(L'\0'); }
      names.push_back(L'\0'); memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, sizeof(DROPFILES) + names.size() * sizeof(wchar_t));
      if (!memory) return E_OUTOFMEMORY;
      void* locked = GlobalLock(memory); if (!locked) { GlobalFree(memory); return E_OUTOFMEMORY; }
      auto* drop = static_cast<DROPFILES*>(locked); drop->pFiles = sizeof(DROPFILES); drop->fWide = TRUE;
      std::memcpy(static_cast<BYTE*>(locked) + sizeof(DROPFILES), names.data(), names.size() * sizeof(wchar_t)); GlobalUnlock(memory);
    } else if (format->cfFormat == static_cast<CLIPFORMAT>(RegisterClipboardFormatW(L"Preferred DropEffect"))) {
      memory = GlobalAlloc(GMEM_MOVEABLE, sizeof(effect_)); if (!memory) return E_OUTOFMEMORY;
      void* locked = GlobalLock(memory); if (!locked) { GlobalFree(memory); return E_OUTOFMEMORY; }
      std::memcpy(locked, &effect_, sizeof(effect_)); GlobalUnlock(memory);
    } else return DV_E_FORMATETC;
    *medium = STGMEDIUM{}; medium->tymed = TYMED_HGLOBAL; medium->hGlobal = memory; return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetDataHere(FORMATETC*, STGMEDIUM*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE QueryGetData(FORMATETC* format) override {
    return format && (format->cfFormat == CF_HDROP || format->cfFormat == static_cast<CLIPFORMAT>(RegisterClipboardFormatW(L"Preferred DropEffect"))) ? S_OK : DV_E_FORMATETC;
  }
  HRESULT STDMETHODCALLTYPE GetCanonicalFormatEtc(FORMATETC*, FORMATETC* output) override { if (output) output->ptd = nullptr; return DATA_S_SAMEFORMATETC; }
  HRESULT STDMETHODCALLTYPE SetData(FORMATETC*, STGMEDIUM*, BOOL) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE EnumFormatEtc(DWORD, IEnumFORMATETC** output) override { if (output) *output = nullptr; return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE DAdvise(FORMATETC*, DWORD, IAdviseSink*, DWORD*) override { return OLE_E_ADVISENOTSUPPORTED; }
  HRESULT STDMETHODCALLTYPE DUnadvise(DWORD) override { return OLE_E_ADVISENOTSUPPORTED; }
  HRESULT STDMETHODCALLTYPE EnumDAdvise(IEnumSTATDATA** output) override { if (output) *output = nullptr; return OLE_E_ADVISENOTSUPPORTED; }
 private:
  ~ClipboardTestDataObject() = default;
  std::atomic<ULONG> references_{1};
  std::vector<std::wstring> paths_;
  DWORD effect_;
  std::shared_ptr<ClipboardTestOwnerGate> gate_;
};

class ClipboardTestBackend final : public ClipboardBackend {
 public:
  explicit ClipboardTestBackend(std::shared_ptr<SessionState> state = {}) : state_(std::move(state)), gate_(CurrentClipboardTestOwnerGate()) { Set({L"C:/tmp/first.txt", L"C:/tmp/remaining.txt"}); }
  ~ClipboardTestBackend() override { if (current_) current_->Release(); }
  DWORD Sequence() override { return sequence_; }
  HRESULT GetDataObject(IDataObject** output) override { if (!output) return E_POINTER; *output = current_; if (*output) (*output)->AddRef(); return S_OK; }
  HRESULT GetIdentity(const std::wstring& path, ClipboardFileIdentity* output) override {
    const unsigned count = ++identity_reads_[path];
    if (path == L"C:/tmp/first.txt" && count > 1) return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
    if (path != L"C:/tmp/first.txt" && path != L"C:/tmp/remaining.txt") return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
    *output = ClipboardFileIdentity{}; output->volume = 19; output->id.Identifier[0] = path == L"C:/tmp/first.txt" ? 1 : 2; return S_OK;
  }
  HRESULT Replace(const std::vector<std::wstring>& paths, const std::wstring&, bool check, DWORD expected, DWORD* published_sequence = nullptr) override {
    if (check && sequence_ != expected) return HRESULT_FROM_WIN32(ERROR_RETRY);
    ++sequence_; Set(paths); if (published_sequence) *published_sequence = sequence_; return S_OK;
  }
  bool IsClosed() const override { return (state_ && state_->closed.load()) || (gate_ && gate_->closed.load()); }
 private:
  void Set(std::vector<std::wstring> paths) { if (current_) current_->Release(); current_ = paths.empty() ? nullptr : new ClipboardTestDataObject(std::move(paths), DROPEFFECT_MOVE, gate_); }
  DWORD sequence_ = 33;
  ClipboardTestDataObject* current_ = nullptr;
  std::shared_ptr<SessionState> state_;
  std::shared_ptr<ClipboardTestOwnerGate> gate_;
  std::map<std::wstring, unsigned> identity_reads_;
};

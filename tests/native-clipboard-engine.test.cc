#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objidl.h>
#include <shellapi.h>
#include <shlobj.h>
#include "../native/src/clipboard-ole-engine.h"
#include <algorithm>
#include <atomic>
#include <memory>
#include <thread>
#include <cstring>
#include <iostream>
#include <unordered_map>
#include <utility>

namespace {
CLIPFORMAT ClipboardFormat(const wchar_t* name) {
  return static_cast<CLIPFORMAT>(static_cast<SHORT>(RegisterClipboardFormatW(name)));
}

struct FakeOwnerGate {
  FakeOwnerGate() {
    entered = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    release = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  }
  ~FakeOwnerGate() { if (entered) CloseHandle(entered); if (release) CloseHandle(release); }
  HANDLE entered = nullptr;
  HANDLE release = nullptr;
  std::atomic<bool> block_drop{false};
  std::atomic<bool> block_identity{false};
  std::atomic<bool> closed{false};
};

class FakeDataObject final : public IDataObject {
 public:
  FakeDataObject(std::vector<std::wstring> paths, DWORD effect, std::shared_ptr<FakeOwnerGate> gate = {})
      : paths_(std::move(paths)), effect_(effect), gate_(std::move(gate)) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** output) override {
    if (!output) return E_POINTER;
    if (iid == IID_IUnknown || iid == IID_IDataObject) { *output = static_cast<IDataObject*>(this); AddRef(); return S_OK; }
    *output = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG remaining = --references_;
    if (!remaining) delete this;
    return remaining;
  }
  HRESULT STDMETHODCALLTYPE GetData(FORMATETC* format, STGMEDIUM* medium) override {
    if (!format || !medium) return E_POINTER;
    if (format->cfFormat == CF_HDROP) {
      ++drop_get_calls;
      if (gate_ && gate_->block_drop.exchange(false)) {
        SetEvent(gate_->entered);
        WaitForSingleObject(gate_->release, INFINITE);
      }
      std::vector<wchar_t> names;
      for (const auto& path : paths_) { names.insert(names.end(), path.begin(), path.end()); names.push_back(L'\0'); }
      names.push_back(L'\0');
      const size_t bytes = sizeof(DROPFILES) + names.size() * sizeof(wchar_t);
      HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes);
      if (!memory) return E_OUTOFMEMORY;
      void* locked = GlobalLock(memory);
      if (!locked) { GlobalFree(memory); return E_OUTOFMEMORY; }
      auto* drop = static_cast<DROPFILES*>(locked);
      drop->pFiles = sizeof(DROPFILES);
      drop->fWide = TRUE;
      std::memcpy(static_cast<unsigned char*>(locked) + sizeof(DROPFILES), names.data(), names.size() * sizeof(wchar_t));
      GlobalUnlock(memory);
      *medium = STGMEDIUM{};
      medium->tymed = TYMED_HGLOBAL;
      medium->hGlobal = memory;
      return S_OK;
    }
    if (format->cfFormat == ClipboardFormat(L"Preferred DropEffect")) {
      ++effect_get_calls;
      HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, sizeof(effect_));
      if (!memory) return E_OUTOFMEMORY;
      void* locked = GlobalLock(memory);
      if (!locked) { GlobalFree(memory); return E_OUTOFMEMORY; }
      std::memcpy(locked, &effect_, sizeof(effect_));
      GlobalUnlock(memory);
      *medium = STGMEDIUM{};
      medium->tymed = TYMED_HGLOBAL;
      medium->hGlobal = memory;
      return S_OK;
    }
    return DV_E_FORMATETC;
  }
  HRESULT STDMETHODCALLTYPE GetDataHere(FORMATETC*, STGMEDIUM*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE QueryGetData(FORMATETC* format) override {
    if (!format) return E_POINTER;
    if (format->cfFormat == CF_HDROP) return drop_query;
    if (format->cfFormat == ClipboardFormat(L"Preferred DropEffect")) return effect_query;
    return DV_E_FORMATETC;
  }
  HRESULT STDMETHODCALLTYPE GetCanonicalFormatEtc(FORMATETC*, FORMATETC* output) override {
    if (output) output->ptd = nullptr;
    return DATA_S_SAMEFORMATETC;
  }
  HRESULT STDMETHODCALLTYPE SetData(FORMATETC* format, STGMEDIUM* medium, BOOL release) override {
    if (!format || !medium || medium->tymed != TYMED_HGLOBAL) return DV_E_FORMATETC;
    void* locked = GlobalLock(medium->hGlobal);
    if (!locked) return E_FAIL;
    const DWORD effect = *static_cast<const DWORD*>(locked);
    GlobalUnlock(medium->hGlobal);
    if (format->cfFormat == ClipboardFormat(L"Performed DropEffect")) notifications.emplace_back(L"Performed DropEffect", effect);
    else if (format->cfFormat == ClipboardFormat(L"Paste Succeeded")) notifications.emplace_back(L"Paste Succeeded", effect);
    else return DV_E_FORMATETC;
    if (release) ReleaseStgMedium(medium);
    return notification_result;
  }
  HRESULT STDMETHODCALLTYPE EnumFormatEtc(DWORD, IEnumFORMATETC** output) override { if (output) *output = nullptr; return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE DAdvise(FORMATETC*, DWORD, IAdviseSink*, DWORD*) override { return OLE_E_ADVISENOTSUPPORTED; }
  HRESULT STDMETHODCALLTYPE DUnadvise(DWORD) override { return OLE_E_ADVISENOTSUPPORTED; }
  HRESULT STDMETHODCALLTYPE EnumDAdvise(IEnumSTATDATA** output) override { if (output) *output = nullptr; return OLE_E_ADVISENOTSUPPORTED; }

  std::vector<std::pair<std::wstring, DWORD>> notifications;
  HRESULT notification_result = S_OK;
  HRESULT drop_query = S_OK;
  HRESULT effect_query = S_OK;
  unsigned drop_get_calls = 0;
  unsigned effect_get_calls = 0;
 private:
  ~FakeDataObject() = default;
  std::atomic<ULONG> references_{1};
  std::vector<std::wstring> paths_;
  DWORD effect_;
  std::shared_ptr<FakeOwnerGate> gate_;
};

class FakeBackend final : public ClipboardBackend {
 public:
  explicit FakeBackend(std::shared_ptr<FakeOwnerGate> gate = {}) : gate_(std::move(gate)) { SetCurrent({ L"C:/tmp/Größe.txt", L"C:/tmp/second.txt" }, L"move"); }
  ~FakeBackend() override { if (current_) current_->Release(); }
  DWORD Sequence() override { return sequence_; }
  HRESULT GetDataObject(IDataObject** output) override {
    if (!output) return E_POINTER;
    *output = current_;
    if (*output) (*output)->AddRef();
    return S_OK;
  }
  HRESULT Replace(const std::vector<std::wstring>& paths, const std::wstring& mode,
                  bool check_sequence, DWORD expected_sequence) override {
    if (check_sequence && sequence_ != expected_sequence) return HRESULT_FROM_WIN32(ERROR_RETRY);
    replacements.emplace_back(paths, mode);
    ++sequence_;
    SetCurrent(paths, mode);
    return S_OK;
  }
  HRESULT GetIdentity(const std::wstring& path, ClipboardFileIdentity* output) override {
    ++identity_calls;
    if (gate_ && gate_->block_identity.exchange(false)) {
      SetEvent(gate_->entered);
      WaitForSingleObject(gate_->release, INFINITE);
    }
    auto found = identities.find(path);
    if (found == identities.end()) return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
    *output = found->second;
    return S_OK;
  }
  bool IsClosed() const override { return gate_ && gate_->closed.load(); }
  void CloseAndReleaseOwner() { if (gate_) { gate_->closed.store(true); SetEvent(gate_->release); } }
  void BlockNextDropRead() { if (gate_) { ResetEvent(gate_->entered); ResetEvent(gate_->release); gate_->block_drop.store(true); } }
  void BlockNextIdentityRead() { if (gate_) { ResetEvent(gate_->entered); ResetEvent(gate_->release); gate_->block_identity.store(true); } }
  bool WaitForBlockedOwner(DWORD milliseconds) const { return gate_ && WaitForSingleObject(gate_->entered, milliseconds) == WAIT_OBJECT_0; }
  void SetCurrent(const std::vector<std::wstring>& paths, const std::wstring& mode) {
    if (current_) current_->Release();
    current_ = paths.empty() ? nullptr : new FakeDataObject(paths, mode == L"move" ? DROPEFFECT_MOVE : DROPEFFECT_COPY, gate_);
    identities.clear();
    for (size_t index = 0; index < paths.size(); ++index) {
      ClipboardFileIdentity identity{};
      identity.volume = 77;
      std::memset(identity.id.Identifier, 0, sizeof(identity.id.Identifier));
      identity.id.Identifier[0] = static_cast<BYTE>(index + 1);
      identities.emplace(paths[index], identity);
    }
  }
  void Remove(const std::wstring& path) { identities.erase(path); }
  void ReplaceIdentity(const std::wstring& path) {
    auto& identity = identities[path];
    identity.volume = 88;
  }
  FakeDataObject* current() const { return current_; }
  std::vector<std::pair<std::vector<std::wstring>, std::wstring>> replacements;
 private:
  DWORD sequence_ = 7;
  FakeDataObject* current_ = nullptr;
  std::unordered_map<std::wstring, ClipboardFileIdentity> identities;
  std::shared_ptr<FakeOwnerGate> gate_;
 public:
  unsigned identity_calls = 0;
};

bool Check(bool condition, const char* message) {
  if (condition) return true;
  std::cerr << message << '\n';
  return false;
}

int Run() {
  HRESULT com = OleInitialize(nullptr);
  if (FAILED(com)) return 2;
  int failures = 0;
  {
    auto gate = std::make_shared<FakeOwnerGate>();
    FakeBackend backend(gate);
    backend.BlockNextDropRead();
    ClipboardOleEngine engine(&backend);
    ClipboardSelection selection;
    std::thread closer([&] { backend.WaitForBlockedOwner(5000); backend.CloseAndReleaseOwner(); });
    const HRESULT status = engine.Read(&selection);
    closer.join();
    if (!Check(status == HRESULT_FROM_WIN32(ERROR_CANCELLED), "close during a blocked owner read cancels the read")) ++failures;
    if (!Check(backend.identity_calls == 0 && backend.current()->effect_get_calls == 0, "close during owner read starts no effect or identity phase")) ++failures;
  }
  {
    auto gate = std::make_shared<FakeOwnerGate>();
    FakeBackend backend(gate);
    backend.BlockNextIdentityRead();
    ClipboardOleEngine engine(&backend);
    ClipboardSelection selection;
    std::thread closer([&] { backend.WaitForBlockedOwner(5000); backend.CloseAndReleaseOwner(); });
    const HRESULT status = engine.Write({ L"C:/tmp/first.txt" }, L"copy", &selection);
    closer.join();
    if (!Check(status == HRESULT_FROM_WIN32(ERROR_CANCELLED), "close during blocked identity preparation cancels the write")) ++failures;
    if (!Check(backend.replacements.empty(), "close during identity preparation starts no clipboard publication")) ++failures;
  }
  for (const HRESULT unavailable : { S_FALSE, DV_E_FORMATETC, DV_E_CLIPFORMAT, DV_E_TYMED }) {
    FakeBackend backend;
    backend.current()->drop_query = unavailable;
    ClipboardOleEngine engine(&backend);
    ClipboardSelection selection;
    if (!Check(SUCCEEDED(engine.Read(&selection)) && selection.paths.empty(), "unsupported file format produces an empty selection")) ++failures;
  }
  for (const HRESULT unavailable : { S_FALSE, DV_E_FORMATETC, DV_E_CLIPFORMAT, DV_E_TYMED }) {
    FakeBackend backend;
    backend.current()->effect_query = unavailable;
    ClipboardOleEngine engine(&backend);
    ClipboardSelection selection;
    if (!Check(SUCCEEDED(engine.Read(&selection)) && !selection.paths.empty() && selection.mode == L"copy", "absent preferred effect preserves files as copy")) ++failures;
  }
  {
    FakeBackend backend;
    backend.current()->drop_query = E_ACCESSDENIED;
    ClipboardOleEngine engine(&backend);
    ClipboardSelection selection;
    if (!Check(engine.Read(&selection) == E_ACCESSDENIED, "access errors remain errors instead of empty selections")) ++failures;
  }
  {
    FakeBackend backend;
    ClipboardOleEngine engine(&backend);
    ClipboardSelection selection;
    HRESULT status = engine.Read(&selection);
    FakeDataObject* retained = backend.current();
    if (retained) retained->AddRef();
    if (!Check(SUCCEEDED(status) && selection.paths.size() == 2 && selection.mode == L"move" && !selection.token.empty(), "read binds paths, move effect, and token")) ++failures;
    backend.Remove(L"C:/tmp/Größe.txt");
    backend.Remove(L"C:/tmp/second.txt");
    bool matched = false;
    std::vector<std::string> errors;
    status = engine.Acknowledge(selection.token, selection.paths, selection.mode, {}, &matched, &errors);
    if (!Check(SUCCEEDED(status) && matched, "complete move acknowledgement succeeds")) ++failures;
    if (!Check(retained->notifications.size() == 2 && retained->notifications[0] == std::pair<std::wstring, DWORD>(L"Performed DropEffect", DROPEFFECT_NONE) && retained->notifications[1] == std::pair<std::wstring, DWORD>(L"Paste Succeeded", DROPEFFECT_MOVE), "notifications reach the exact retained IDataObject")) ++failures;
    if (!Check(backend.replacements.size() == 1 && backend.replacements[0].first.empty(), "complete acknowledgement clears the selected file formats")) ++failures;
    if (retained) retained->Release();
  }
  {
    FakeBackend backend;
    ClipboardOleEngine engine(&backend);
    ClipboardSelection selection;
    engine.Read(&selection);
    backend.Remove(L"C:/tmp/Größe.txt");
    bool matched = false;
    std::vector<std::string> errors;
    HRESULT status = engine.Acknowledge(selection.token, selection.paths, selection.mode,
      { L"C:/tmp/second.txt" }, &matched, &errors);
    if (!Check(SUCCEEDED(status) && matched && backend.replacements.size() == 1 && backend.replacements[0].first == std::vector<std::wstring>{ L"C:/tmp/second.txt" }, "partial move preserves the ordered remaining selection")) ++failures;
    if (!Check(backend.current()->notifications.empty(), "partial move does not claim a complete external paste")) ++failures;
  }
  {
    FakeBackend backend;
    backend.SetCurrent({ L"C:/tmp/Größe.txt", L"C:/tmp/second.txt" }, L"copy");
    ClipboardOleEngine engine(&backend);
    ClipboardSelection selection;
    engine.Read(&selection);
    bool matched = false;
    std::vector<std::string> errors;
    HRESULT status = engine.Acknowledge(selection.token, selection.paths, selection.mode, {}, &matched, &errors);
    if (!Check(SUCCEEDED(status) && matched && backend.replacements.size() == 1 && backend.replacements[0].first.empty(), "copy acknowledgement can clear the source selection while source identities remain")) ++failures;
    if (!Check(backend.current() == nullptr, "copy acknowledgement does not require source deletion")) ++failures;
  }
  {
    FakeBackend backend;
    ClipboardOleEngine engine(&backend);
    ClipboardSelection selection;
    engine.Read(&selection);
    backend.ReplaceIdentity(L"C:/tmp/second.txt");
    bool matched = false;
    std::vector<std::string> errors;
    HRESULT status = engine.Acknowledge(selection.token, selection.paths, selection.mode,
      { L"C:/tmp/second.txt" }, &matched, &errors);
    if (!Check(SUCCEEDED(status) && !matched && backend.replacements.empty(), "replaced remaining path identity prevents acknowledgement")) ++failures;
  }
  {
    FakeBackend backend;
    ClipboardOleEngine engine(&backend);
    ClipboardSelection selection;
    engine.Read(&selection);
    backend.Replace({ L"C:/tmp/new.txt" }, L"copy", false, 0);
    bool matched = false;
    std::vector<std::string> errors;
    HRESULT status = engine.Acknowledge(selection.token, selection.paths, selection.mode, {}, &matched, &errors);
    if (!Check(SUCCEEDED(status) && !matched && backend.replacements.size() == 1, "changed sequence preserves concurrent clipboard contents")) ++failures;
  }
  {
    FakeBackend backend;
    backend.current()->notification_result = E_NOTIMPL;
    ClipboardOleEngine engine(&backend);
    ClipboardSelection selection;
    engine.Read(&selection);
    backend.Remove(L"C:/tmp/Größe.txt");
    backend.Remove(L"C:/tmp/second.txt");
    bool matched = false;
    std::vector<std::string> errors;
    HRESULT status = engine.Acknowledge(selection.token, selection.paths, selection.mode, {}, &matched, &errors);
    if (!Check(SUCCEEDED(status) && matched && errors.size() == 2, "unsupported optional callbacks are reported separately from local completion")) ++failures;
  }
  {
    FakeBackend backend;
    backend.current()->notification_result = E_ACCESSDENIED;
    ClipboardOleEngine engine(&backend);
    ClipboardSelection selection;
    engine.Read(&selection);
    backend.Remove(L"C:/tmp/Größe.txt");
    backend.Remove(L"C:/tmp/second.txt");
    bool matched = false;
    std::vector<std::string> errors;
    HRESULT status = engine.Acknowledge(selection.token, selection.paths, selection.mode, {}, &matched, &errors);
    if (!Check(status == E_ACCESSDENIED && !matched && backend.replacements.empty(), "unexpected callback failure is not reported as successful acknowledgement")) ++failures;
  }
  OleUninitialize();
  return failures ? 1 : 0;
}
}

int wmain() { return Run(); }

#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objidl.h>
#include <string>
#include <vector>

struct ClipboardFileIdentity {
  ULONGLONG volume = 0;
  FILE_ID_128 id{};
  bool directory = false;
};

struct ClipboardSelection {
  std::vector<std::wstring> paths;
  std::wstring mode;
  std::wstring token;
  std::vector<std::string> notification_errors;
};

class ClipboardBackend {
 public:
  virtual ~ClipboardBackend() = default;
  virtual DWORD Sequence() = 0;
  virtual HRESULT GetDataObject(IDataObject** data) = 0;
  virtual HRESULT Replace(const std::vector<std::wstring>& paths, const std::wstring& mode,
                          bool check_sequence, DWORD expected_sequence, DWORD* published_sequence = nullptr) = 0;
  virtual HRESULT GetIdentity(const std::wstring& path, ClipboardFileIdentity* identity) = 0;
  virtual bool IsClosed() const { return false; }
};

class ClipboardOleEngine {
 public:
  explicit ClipboardOleEngine(ClipboardBackend* backend);
  ~ClipboardOleEngine();
  ClipboardOleEngine(const ClipboardOleEngine&) = delete;
  ClipboardOleEngine& operator=(const ClipboardOleEngine&) = delete;

  HRESULT Read(ClipboardSelection* selection, const DWORD* expected_sequence = nullptr);
  HRESULT Write(const std::vector<std::wstring>& paths, const std::wstring& mode,
                ClipboardSelection* selection);
  HRESULT Acknowledge(const std::wstring& token, const std::vector<std::wstring>& paths,
                      const std::wstring& mode, const std::vector<std::wstring>& remaining,
                      bool* matched, std::vector<std::string>* notification_errors);
  void Reset();
  HRESULT Cancel(const std::wstring& token, const std::vector<std::wstring>& paths,
                 const std::wstring& mode, bool* matched);

 private:
  struct Entry {
    std::wstring path;
    ClipboardFileIdentity identity;
  };
  HRESULT ReadCurrent(IDataObject** data, DWORD* sequence, ClipboardSelection* selection,
                      std::vector<Entry>* entries);
  ClipboardBackend* backend_;
  IDataObject* retained_ = nullptr;
  DWORD sequence_ = 0;
  std::wstring token_;
  std::wstring mode_;
  std::vector<Entry> entries_;
  ULONGLONG next_token_ = 1;
};

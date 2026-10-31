#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shobjidl.h>
#include <cstdio>
#include <cstring>
#include <vector>
#include "../../native/src/shell-context-win.h"

class FakeContextMenu final : public IContextMenu3 {
 public:
  ULONG refs = 1;
  unsigned int verb_calls = 0, second_calls = 0, third_calls = 0;
  HRESULT third_result = S_OK, second_result = S_OK;
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
    if (iid == IID_IUnknown || iid == IID_IContextMenu || iid == IID_IContextMenu2 || iid == IID_IContextMenu3) {
      *object = static_cast<IContextMenu3*>(this); AddRef(); return S_OK;
    }
    *object = nullptr; return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
  ULONG STDMETHODCALLTYPE Release() override { return --refs; }
  HRESULT STDMETHODCALLTYPE QueryContextMenu(HMENU, UINT, UINT, UINT, UINT) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE InvokeCommand(LPCMINVOKECOMMANDINFO) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE GetCommandString(UINT_PTR, UINT flags, UINT*, LPSTR text, UINT count) override {
    if (flags == GCS_VERBW && text && count >= 5) {
      wcscpy_s(reinterpret_cast<wchar_t*>(text), count / sizeof(wchar_t), L"open");
      ++verb_calls;
      return S_OK;
    }
    return E_FAIL;
  }
  HRESULT STDMETHODCALLTYPE HandleMenuMsg(UINT, WPARAM, LPARAM) override { ++second_calls; return second_result; }
  HRESULT STDMETHODCALLTYPE HandleMenuMsg2(UINT, WPARAM, LPARAM, LRESULT* result) override {
    ++third_calls; *result = 0x55; return third_result;
  }
};

int wmain() {
  FakeContextMenu fake;
  HMENU menu = CreatePopupMenu();
  HMENU submenu = CreatePopupMenu();
  if (!menu || !submenu) return 2;
  if (!AppendMenuW(menu, MF_STRING, 1, L"Open") || !AppendMenuW(submenu, MF_STRING, 2, L"Nested") ||
      !AppendMenuW(menu, MF_POPUP, reinterpret_cast<UINT_PTR>(submenu), L"Advanced")) return 3;
  std::vector<ShellContextMenuEntry> entries;
  DWORD error = 0;
  if (!EnumerateShellMenu(menu, &fake, &entries, &error) || entries.size() != 2 ||
      entries[0].label != L"Open" || entries[0].verb != L"open" || entries[0].submenu ||
      entries[1].label != L"Advanced" || !entries[1].submenu || fake.verb_calls != 1) return 4;
  LRESULT result = 0;
  if (!RelayShellMenuMessage(static_cast<IContextMenu2*>(&fake), &fake, WM_DRAWITEM, 7, 9, &result) ||
      result != 0x55 || fake.third_calls != 1 || fake.second_calls != 0) return 5;
  fake.third_result = E_FAIL;
  if (!RelayShellMenuMessage(static_cast<IContextMenu2*>(&fake), &fake, WM_MENUCHAR, 1, 2, &result) ||
      result != 0 || fake.second_calls != 1) return 6;
  fake.second_result = E_FAIL;
  if (RelayShellMenuMessage(static_cast<IContextMenu2*>(&fake), &fake, WM_MEASUREITEM, 0, 0, &result)) return 7;
  if (RelayShellMenuMessage(static_cast<IContextMenu2*>(&fake), &fake, WM_NULL, 0, 0, &result)) return 8;
  DestroyMenu(menu);
  DestroyMenu(submenu);
  std::wprintf(L"entries=2 verbCalls=%u secondCalls=%u thirdCalls=%u result=ok\n",
               fake.verb_calls, fake.second_calls, fake.third_calls);
  return 0;
}

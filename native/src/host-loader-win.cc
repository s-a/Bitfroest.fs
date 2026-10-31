#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <delayimp.h>
#include <cstring>

namespace {
FARPROC WINAPI ResolveHost(unsigned event, PDelayLoadInfo info) {
  if (event != dliNotePreLoadLibrary || _stricmp(info->szDll, "node.exe") != 0) return nullptr;
  HMODULE host = GetModuleHandleW(L"libnode.dll");
  if (!host) host = GetModuleHandleW(nullptr);
  return reinterpret_cast<FARPROC>(host);
}
}

extern "C" const PfnDliHook __pfnDliNotifyHook2 = ResolveHost;

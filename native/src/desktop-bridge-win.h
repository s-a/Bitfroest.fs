#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <atomic>

struct DesktopAssociationResult {
  bool editor = false;
};

bool ResolveDesktopAssociation(const std::wstring& path, bool inspect_only,
                               DesktopAssociationResult* result, DWORD* native_error,
                               const std::atomic<bool>* closed = nullptr);
bool ResolveTrashView(bool inspect_only, const std::atomic<bool>& closed, DWORD* native_error);
bool OpenDesktopTerminal(const std::wstring& path, bool inspect_only, std::wstring* parameters,
                         const std::atomic<bool>& closed, DWORD* native_error);

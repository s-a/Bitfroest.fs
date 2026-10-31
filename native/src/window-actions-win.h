#pragma once
#include <windows.h>
#include <atomic>
#include <string>

bool MaximizeOwnedWindow(const std::wstring& token, const std::atomic<bool>& closed, DWORD* error);

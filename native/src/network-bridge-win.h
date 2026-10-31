#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <vector>

bool ResolveNetworkMappings(const std::vector<std::wstring>& drives,
                            std::vector<std::wstring>* mappings,
                            DWORD* native_error);

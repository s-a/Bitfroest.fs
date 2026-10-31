#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <vector>

struct FilesystemIconRequest {
  std::string key;
  std::wstring path;
  std::wstring name;
  std::wstring icon_resource;
  bool folder = false;
};

struct FilesystemIconResult {
  std::string key;
  std::vector<unsigned char> png;
};

bool ResolveFilesystemIcons(const std::vector<FilesystemIconRequest>& requests,
                            std::vector<FilesystemIconResult>* results,
                            DWORD* native_error);

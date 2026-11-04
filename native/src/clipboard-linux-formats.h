#pragma once

#include <string>
#include <vector>

namespace native_linux_clipboard {

enum class FileMode { Copy, Move };

struct FileSelection {
  std::vector<std::string> paths;
  FileMode mode = FileMode::Copy;
};

bool DecodeFileUri(const std::string& uri, std::string* path);
bool ParseUriList(const std::string& data, std::vector<std::string>* paths);
bool ParseGnomeCopiedFiles(const std::string& data, FileSelection* selection);
bool EncodeUriList(const std::vector<std::string>& paths, std::string* data);
bool EncodeGnomeCopiedFiles(const FileSelection& selection, std::string* data);

}  // namespace native_linux_clipboard

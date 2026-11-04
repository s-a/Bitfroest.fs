#include "clipboard-linux-formats.h"

#include <cctype>
#include <string_view>

namespace native_linux_clipboard {
namespace {
constexpr size_t kMaxPaths = 1024;
constexpr size_t kMaxData = 1048576;

int Hex(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

bool SafePath(const std::string& path) {
  if (path.empty() || path.front() != '/' || path.size() > 4096 || path.find('\0') != std::string::npos) return false;
  size_t begin = 1;
  while (begin <= path.size()) {
    const size_t end = path.find('/', begin);
    const auto segment = std::string_view(path).substr(begin, end == std::string::npos ? path.size() - begin : end - begin);
    if (segment == "..") return false;
    if (end == std::string::npos) break;
    begin = end + 1;
  }
  return true;
}

bool DecodeUriPath(std::string_view uri, std::string* path) {
  if (!path || uri.rfind("file://", 0) != 0) return false;
  uri.remove_prefix(7);
  if (uri.rfind("localhost/", 0) == 0) uri.remove_prefix(9);
  else if (uri.empty() || uri.front() != '/') return false;
  std::string decoded;
  decoded.reserve(uri.size());
  for (size_t i = 0; i < uri.size(); ++i) {
    const unsigned char value = static_cast<unsigned char>(uri[i]);
    if (value == '%') {
      if (i + 2 >= uri.size()) return false;
      const int high = Hex(uri[i + 1]), low = Hex(uri[i + 2]);
      if (high < 0 || low < 0) return false;
      const char byte = static_cast<char>((high << 4) | low);
      if (byte == '\0') return false;
      decoded.push_back(byte);
      i += 2;
    } else {
      if (value <= 0x20 || value == '#' || value == '?') return false;
      decoded.push_back(static_cast<char>(value));
    }
  }
  if (!SafePath(decoded)) return false;
  *path = std::move(decoded);
  return true;
}

bool EncodePath(const std::string& path, std::string* uri) {
  if (!uri || !SafePath(path)) return false;
  static constexpr char hex[] = "0123456789ABCDEF";
  std::string encoded = "file://";
  for (unsigned char value : path) {
    if ((value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') ||
        (value >= '0' && value <= '9') || value == '-' || value == '_' || value == '.' ||
        value == '~' || value == '/') encoded.push_back(static_cast<char>(value));
    else {
      encoded.push_back('%');
      encoded.push_back(hex[value >> 4]);
      encoded.push_back(hex[value & 15]);
    }
  }
  if (encoded.size() > 12288) return false;
  *uri = std::move(encoded);
  return true;
}

bool LinesToPaths(const std::string& data, std::vector<std::string>* paths) {
  if (!paths || data.size() > kMaxData) return false;
  std::vector<std::string> parsed;
  size_t begin = 0;
  while (begin < data.size()) {
    const size_t end = data.find('\n', begin);
    std::string_view line(data.data() + begin, (end == std::string::npos ? data.size() : end) - begin);
    if (!line.empty() && line.back() == '\r') line.remove_suffix(1);
    if (!line.empty() && line.front() != '#') {
      std::string path;
      if (!DecodeUriPath(line, &path)) return false;
      parsed.push_back(std::move(path));
      if (parsed.size() > kMaxPaths) return false;
    }
    if (end == std::string::npos) break;
    begin = end + 1;
  }
  if (parsed.empty()) return false;
  *paths = std::move(parsed);
  return true;
}

bool PathsToLines(const std::vector<std::string>& paths, std::string* data) {
  if (!data || paths.empty() || paths.size() > kMaxPaths) return false;
  std::string encoded;
  for (const auto& path : paths) {
    std::string uri;
    if (!EncodePath(path, &uri)) return false;
    if (!encoded.empty()) encoded += "\r\n";
    encoded += uri;
    if (encoded.size() > kMaxData) return false;
  }
  encoded += "\r\n";
  if (encoded.size() > kMaxData) return false;
  *data = std::move(encoded);
  return true;
}
}  // namespace

bool DecodeFileUri(const std::string& uri, std::string* path) {
  return DecodeUriPath(uri, path);
}

bool ParseUriList(const std::string& data, std::vector<std::string>* paths) {
  return LinesToPaths(data, paths);
}

bool ParseGnomeCopiedFiles(const std::string& data, FileSelection* selection) {
  if (!selection || data.size() > kMaxData) return false;
  const size_t end = data.find('\n');
  if (end == std::string::npos) return false;
  std::string_view mode(data.data(), end);
  if (!mode.empty() && mode.back() == '\r') mode.remove_suffix(1);
  if (mode == "copy") selection->mode = FileMode::Copy;
  else if (mode == "cut") selection->mode = FileMode::Move;
  else return false;
  return LinesToPaths(data.substr(end + 1), &selection->paths);
}

bool EncodeUriList(const std::vector<std::string>& paths, std::string* data) {
  return PathsToLines(paths, data);
}

bool EncodeGnomeCopiedFiles(const FileSelection& selection, std::string* data) {
  if (!data) return false;
  std::string uris;
  if (!PathsToLines(selection.paths, &uris)) return false;
  std::string encoded = selection.mode == FileMode::Move ? "cut\n" : "copy\n";
  encoded += uris;
  if (encoded.size() > kMaxData) return false;
  *data = std::move(encoded);
  return true;
}
}  // namespace native_linux_clipboard

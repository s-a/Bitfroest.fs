#include "folder-icons-posix.h"
#include <gio/gio.h>
#include <algorithm>
#include <cstring>
#include <cstdlib>
#include <dlfcn.h>
#include <fcntl.h>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <sys/stat.h>
#include <unistd.h>

namespace {
struct Api {
  void* gio = dlopen("libgio-2.0.so.0", RTLD_NOW | RTLD_LOCAL);
  void* pixbuf = dlopen("libgdk_pixbuf-2.0.so.0", RTLD_NOW | RTLD_LOCAL);
#define GIO(name) decltype(&name) name##_fn = reinterpret_cast<decltype(&name)>(gio ? dlsym(gio, #name) : nullptr)
  GIO(g_file_new_for_path); GIO(g_file_query_info); GIO(g_file_info_get_attribute_string);
  GIO(g_file_info_get_icon); GIO(g_themed_icon_get_names); GIO(g_themed_icon_get_type);
  GIO(g_file_icon_get_file); GIO(g_file_icon_get_type); GIO(g_file_get_path); GIO(g_file_new_for_uri);
  GIO(g_type_check_instance_is_a); GIO(g_object_unref); GIO(g_free); GIO(g_error_free);
  GIO(g_memory_input_stream_new_from_data);
  GIO(g_settings_schema_source_get_default); GIO(g_settings_schema_source_lookup);
  GIO(g_settings_schema_unref); GIO(g_settings_new_full); GIO(g_settings_get_string);
#undef GIO
  void* (*load)(GInputStream*, int, int, gboolean, GCancellable*, GError**) =
      reinterpret_cast<decltype(load)>(pixbuf ? dlsym(pixbuf, "gdk_pixbuf_new_from_stream_at_scale") : nullptr);
  gboolean (*save)(void*, gchar**, gsize*, const char*, char**, char**, GError**) =
      reinterpret_cast<decltype(save)>(pixbuf ? dlsym(pixbuf, "gdk_pixbuf_save_to_bufferv") : nullptr);
  bool available() const {
    return gio && pixbuf && load && save && g_file_new_for_path_fn && g_file_query_info_fn &&
        g_file_info_get_attribute_string_fn && g_file_info_get_icon_fn && g_themed_icon_get_names_fn &&
        g_themed_icon_get_type_fn && g_file_icon_get_file_fn && g_file_icon_get_type_fn && g_file_get_path_fn &&
        g_file_new_for_uri_fn && g_type_check_instance_is_a_fn && g_object_unref_fn && g_free_fn &&
        g_error_free_fn && g_memory_input_stream_new_from_data_fn;
  }
  ~Api() { if (pixbuf) dlclose(pixbuf); if (gio) dlclose(gio); }
};
Api& Libraries() { static Api api; return api; }
std::mutex icon_mutex;
std::string Env(const char* name) { const char* value = std::getenv(name); return value ? value : ""; }
std::string Trim(std::string text) {
  const auto first = text.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) return {};
  text = text.substr(first, text.find_last_not_of(" \t\r\n") - first + 1);
  return text;
}
std::vector<std::string> Split(const std::string& text, char delimiter) {
  std::vector<std::string> result;
  std::istringstream stream(text); std::string entry;
  while (std::getline(stream, entry, delimiter)) if (!(entry = Trim(entry)).empty()) result.push_back(entry);
  return result;
}
bool Name(const std::string& name) {
  return !name.empty() && name != "." && name != ".." &&
      name.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.+-") == std::string::npos;
}
std::vector<unsigned char> Read(const std::string& path, size_t limit) {
  if (path.empty() || path.front() != '/') return {};
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  const auto parts = Split(path, '/');
  for (size_t i = 0; fd >= 0 && i < parts.size(); ++i) {
    if (parts[i] == "..") { close(fd); return {}; }
    if (parts[i] == ".") continue;
    const int next = openat(fd, parts[i].c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK |
        (i + 1 < parts.size() ? O_DIRECTORY : 0));
    close(fd); fd = next;
  }
  if (fd < 0) return {};
  struct stat info{};
  if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_size <= 0 || static_cast<uint64_t>(info.st_size) > limit) { close(fd); return {}; }
  std::vector<unsigned char> bytes(static_cast<size_t>(info.st_size));
  size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t count = read(fd, bytes.data() + offset, bytes.size() - offset);
    if (count <= 0) { close(fd); return {}; }
    offset += static_cast<size_t>(count);
  }
  close(fd); return bytes;
}
using Ini = std::map<std::string, std::map<std::string, std::string>>;
Ini ReadIni(const std::string& path) {
  const auto bytes = Read(path, 65536);
  std::istringstream stream(std::string(bytes.begin(), bytes.end()));
  Ini result; std::string line, section;
  while (std::getline(stream, line)) {
    line = Trim(line);
    if (line.empty() || line.front() == '#' || line.front() == ';') continue;
    if (line.front() == '[' && line.back() == ']') section = line.substr(1, line.size() - 2);
    else {
      const auto equal = line.find('=');
      if (equal != std::string::npos) result[section][Trim(line.substr(0, equal))] = Trim(line.substr(equal + 1));
    }
  }
  return result;
}
std::string ConfigRoot() {
  const auto configured = Env("XDG_CONFIG_HOME");
  return !configured.empty() && configured.front() == '/' ? configured : Env("HOME") + "/.config";
}
bool Kde() { return Env("XDG_CURRENT_DESKTOP").find("KDE") != std::string::npos; }
std::string Theme(Api& api) {
  if (Kde()) {
    auto theme = ReadIni(ConfigRoot() + "/kdeglobals")["Icons"]["Theme"];
    if (Name(theme)) return theme;
  }
  auto theme = ReadIni(ConfigRoot() + "/gtk-3.0/settings.ini")["Settings"]["gtk-icon-theme-name"];
  if (theme.size() >= 2 && theme.front() == '"' && theme.back() == '"') theme = theme.substr(1, theme.size() - 2);
  if (Name(theme)) return theme;
  if (api.g_settings_schema_source_get_default_fn && api.g_settings_schema_source_lookup_fn &&
      api.g_settings_new_full_fn && api.g_settings_get_string_fn && api.g_settings_schema_unref_fn) {
    auto* source = api.g_settings_schema_source_get_default_fn();
    auto* schema = source ? api.g_settings_schema_source_lookup_fn(source, "org.gnome.desktop.interface", true) : nullptr;
    if (schema) {
      auto* settings = api.g_settings_new_full_fn(schema, nullptr, nullptr);
      if (settings) {
        char* value = api.g_settings_get_string_fn(settings, "icon-theme");
        if (value) { theme = value; api.g_free_fn(value); }
        api.g_object_unref_fn(settings);
      }
      api.g_settings_schema_unref_fn(schema);
    }
  }
  return Name(theme) ? theme : Kde() ? "breeze" : "Adwaita";
}
std::vector<std::string> Roots() {
  const auto home = Env("HOME");
  std::vector<std::string> roots{home + "/.icons"};
  const auto data = Env("XDG_DATA_HOME");
  roots.push_back((!data.empty() && data.front() == '/' ? data : home + "/.local/share") + "/icons");
  const auto directories = Env("XDG_DATA_DIRS");
  for (const auto& root : Split(directories.empty() ? "/usr/local/share:/usr/share" : directories, ':'))
    if (root.front() == '/') roots.push_back(root + "/icons");
  return roots;
}
std::vector<unsigned char> Render(Api& api, const std::string& path) {
  const auto bytes = Read(path, 4 * 1024 * 1024);
  if (bytes.empty()) return {};
  auto* stream = api.g_memory_input_stream_new_from_data_fn(bytes.data(), static_cast<gssize>(bytes.size()), nullptr);
  GError* error = nullptr;
  void* image = api.load(stream, 32, 32, true, nullptr, &error);
  api.g_object_unref_fn(stream);
  if (error) { api.g_error_free_fn(error); error = nullptr; }
  if (!image) return {};
  gchar* output = nullptr; gsize size = 0;
  std::vector<unsigned char> result;
  if (api.save(image, &output, &size, "png", nullptr, nullptr, &error) && size <= 65536)
    result.assign(reinterpret_cast<unsigned char*>(output), reinterpret_cast<unsigned char*>(output) + size);
  if (output) api.g_free_fn(output);
  if (error) api.g_error_free_fn(error);
  api.g_object_unref_fn(image); return result;
}
std::vector<unsigned char> Lookup(Api& api, const std::string& theme, const std::string& name,
                                const std::vector<std::string>& roots, std::set<std::string>* visited,
                                const std::atomic<bool>& closed) {
  if (closed || !Name(theme) || !Name(name) || !visited->insert(theme).second) return {};
  std::vector<std::string> inherited;
  for (const auto& root : roots) {
    const auto base = root + "/" + theme;
    auto ini = ReadIni(base + "/index.theme");
    auto dirs = Split(ini["Icon Theme"]["Directories"], ',');
    auto scaled = Split(ini["Icon Theme"]["ScaledDirectories"], ',');
    dirs.insert(dirs.end(), scaled.begin(), scaled.end());
    auto parents = Split(ini["Icon Theme"]["Inherits"], ',');
    inherited.insert(inherited.end(), parents.begin(), parents.end());
    auto distance = [&](const std::string& dir) {
      try { return std::abs(std::stoi(ini[dir]["Size"]) * (ini[dir]["Scale"].empty() ? 1 : std::stoi(ini[dir]["Scale"])) - 32); }
      catch (...) { return 100000; }
    };
    std::stable_sort(dirs.begin(), dirs.end(), [&](const auto& left, const auto& right) { return distance(left) < distance(right); });
    for (const auto& dir : dirs) {
      if (closed) return {};
      if (dir.empty() || dir.front() == '/' || dir.find("..") != std::string::npos) continue;
      for (const auto* extension : {".png", ".svg", ".xpm"}) {
        auto png = Render(api, base + "/" + dir + "/" + name + extension);
        if (!png.empty()) return png;
      }
    }
  }
  for (const auto& parent : inherited) {
    auto png = Lookup(api, parent, name, roots, visited, closed);
    if (!png.empty()) return png;
  }
  return {};
}
std::vector<unsigned char> Icon(Api& api, const std::string& reference, const std::string& directory,
                               const std::string& theme, const std::atomic<bool>& closed) {
  if (reference.empty() || closed) return {};
  if (reference.front() == '/') return Render(api, reference);
  if (reference.rfind("./", 0) == 0 && !directory.empty()) return Render(api, directory + "/" + reference.substr(2));
  if (!Name(reference)) return {};
  std::set<std::string> visited;
  const auto roots = Roots();
  auto png = Lookup(api, theme, reference, roots, &visited, closed);
  if (png.empty()) png = Lookup(api, "hicolor", reference, roots, &visited, closed);
  if (!png.empty()) return png;
  for (const auto* extension : {".png", ".svg", ".xpm"}) {
    png = Render(api, "/usr/share/pixmaps/" + reference + extension);
    if (!png.empty()) return png;
  }
  return {};
}
std::vector<unsigned char> GioIcon(Api& api, const PosixIconRequest& request, const std::string& theme,
                                  const std::atomic<bool>& closed, bool custom_only) {
  auto* file = api.g_file_new_for_path_fn(request.path.c_str());
  GError* error = nullptr;
  auto* info = api.g_file_query_info_fn(file, "standard::icon,metadata::custom-icon,metadata::custom-icon-name", G_FILE_QUERY_INFO_NOFOLLOW_SYMLINKS, nullptr, &error);
  api.g_object_unref_fn(file);
  if (error) api.g_error_free_fn(error);
  if (!info) return {};
  std::vector<unsigned char> result;
  const char* uri = api.g_file_info_get_attribute_string_fn(info, "metadata::custom-icon");
  if (uri && std::strlen(uri) <= 4096) {
    auto* icon_file = api.g_file_new_for_uri_fn(uri);
    char* local = api.g_file_get_path_fn(icon_file);
    if (local) { result = Icon(api, local, request.path, theme, closed); api.g_free_fn(local); }
    api.g_object_unref_fn(icon_file);
  }
  const char* name = api.g_file_info_get_attribute_string_fn(info, "metadata::custom-icon-name");
  if (result.empty() && name && std::strlen(name) <= 300) result = Icon(api, name, request.path, theme, closed);
  auto* icon = api.g_file_info_get_icon_fn(info);
  if (result.empty() && !custom_only && icon) {
    if (api.g_type_check_instance_is_a_fn(reinterpret_cast<GTypeInstance*>(icon), api.g_themed_icon_get_type_fn())) {
      const gchar* const* names = api.g_themed_icon_get_names_fn(reinterpret_cast<GThemedIcon*>(icon));
      for (size_t i = 0; names && names[i] && result.empty() && !closed; ++i) result = Icon(api, names[i], request.path, theme, closed);
    } else if (api.g_type_check_instance_is_a_fn(reinterpret_cast<GTypeInstance*>(icon), api.g_file_icon_get_type_fn())) {
      char* local = api.g_file_get_path_fn(api.g_file_icon_get_file_fn(reinterpret_cast<GFileIcon*>(icon)));
      if (local) { result = Icon(api, local, request.path, theme, closed); api.g_free_fn(local); }
    }
  }
  api.g_object_unref_fn(info); return result;
}
}

bool PosixIconsAvailable() { return Libraries().available(); }
std::vector<PosixIconResult> ResolvePosixIcons(const std::vector<PosixIconRequest>& requests, const std::atomic<bool>& closed) {
  std::lock_guard<std::mutex> lock(icon_mutex);
  auto& api = Libraries();
  std::vector<PosixIconResult> results;
  if (!api.available()) return results;
  const auto theme = Theme(api);
  for (const auto& request : requests) {
    PosixIconResult result{request.key, {}};
    if (!closed) {
      struct stat info{};
      const bool exists = !request.path.empty() && lstat(request.path.c_str(), &info) == 0 && !S_ISLNK(info.st_mode);
      if (!request.resource.empty()) result.png = Icon(api, request.resource, request.path, theme, closed);
      if (exists && result.png.empty()) {
        if (!Kde()) result.png = GioIcon(api, request, theme, closed, true);
        if (request.folder && result.png.empty()) result.png = Icon(api, ReadIni(request.path + "/.directory")["Desktop Entry"]["Icon"], request.path, theme, closed);
        if (result.png.empty()) result.png = GioIcon(api, request, theme, closed, false);
      }
    }
    results.push_back(std::move(result));
  }
  return results;
}

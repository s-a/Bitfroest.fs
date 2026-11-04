#include "../native/src/clipboard-linux.h"

#include <cstdlib>
#include <string>

int main() {
  const char* original_display = std::getenv("DISPLAY");
  const char* original_wayland = std::getenv("WAYLAND_DISPLAY");
  const std::string saved_display = original_display ? original_display : "";
  const std::string saved_wayland = original_wayland ? original_wayland : "";
  const bool had_display = original_display != nullptr;
  const bool had_wayland = original_wayland != nullptr;

  unsetenv("DISPLAY");
  setenv("WAYLAND_DISPLAY", "clipboard-test", 1);
  std::string reason;
  const bool available = native_linux_clipboard::Probe(&reason);

  if (had_display) setenv("DISPLAY", saved_display.c_str(), 1);
  else unsetenv("DISPLAY");
  if (had_wayland) setenv("WAYLAND_DISPLAY", saved_wayland.c_str(), 1);
  else unsetenv("WAYLAND_DISPLAY");

  return !available && reason == "UnsupportedWayland" ? 0 : 1;
}

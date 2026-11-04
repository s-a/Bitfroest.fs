#include "../native/src/clipboard-linux.h"
#include "../native/src/clipboard-wayland-linux.h"

#include <cstdlib>
#include <cstring>
#include <string>

namespace {
class EnvironmentValue {
 public:
  explicit EnvironmentValue(const char* name) : name_(name) {
    const char* value = std::getenv(name);
    if (value) { present_ = true; value_ = value; }
  }
  ~EnvironmentValue() {
    if (present_) setenv(name_.c_str(), value_.c_str(), 1);
    else unsetenv(name_.c_str());
  }
 private:
  std::string name_;
  std::string value_;
  bool present_ = false;
};

void Require(bool value) { if (!value) std::abort(); }
}

int main() {
  EnvironmentValue display("WAYLAND_DISPLAY"), socket("WAYLAND_SOCKET");
  unsetenv("WAYLAND_DISPLAY");
  unsetenv("WAYLAND_SOCKET");

  std::string reason;
  Require(!native_linux_wayland_clipboard::Probe(&reason));
  Require(!reason.empty());

  native_linux_wayland_clipboard::Session session;
  native_linux_clipboard::Request request;
  request.operation = native_linux_clipboard::Operation::Read;
  const auto result = session.Invoke(request);
  Require(!result.ok);
  Require(!result.available);
  Require(result.code == "UnsupportedOperation");
  session.Shutdown();
  session.AwaitStopped();
  return 0;
}

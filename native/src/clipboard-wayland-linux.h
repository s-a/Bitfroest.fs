#pragma once

#include "clipboard-linux.h"

#include <memory>
#include <string>

namespace native_linux_wayland_clipboard {

class Session {
 public:
  Session();
  ~Session();
  Session(const Session&) = delete;
  Session& operator=(const Session&) = delete;

  native_linux_clipboard::Result Invoke(const native_linux_clipboard::Request& request);
  void Shutdown();
  void AwaitStopped();
  bool Available() const;
  std::string UnavailableReason() const;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

bool Probe(std::string* reason);

}  // namespace native_linux_wayland_clipboard

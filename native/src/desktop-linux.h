#pragma once

#include <atomic>
#include <string>

struct LinuxDesktopResult {
  bool available = false;
  bool submitted = false;
  bool requested = false;
  bool editor = false;
  int native_error = 0;
  std::string native_domain;
  std::string error;
  bool cancelled = false;
};

bool ProbeLinuxDesktop();
LinuxDesktopResult RunLinuxDesktop(const std::string& path, bool trash,
                                   bool inspect_only,
                                   const std::atomic<bool>* closed);

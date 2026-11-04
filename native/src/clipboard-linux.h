#pragma once

#include <memory>
#include <string>
#include <vector>

namespace native_linux_clipboard {

enum class Operation { Read, Write, Acknowledge, Cancel };
enum class Mode { Copy, Move };

struct Request {
  Operation operation = Operation::Read;
  std::vector<std::string> paths;
  std::vector<std::string> remaining_paths;
  Mode mode = Mode::Copy;
  std::string token;
};

struct Result {
  bool ok = false;
  bool matched = false;
  bool available = false;
  std::string code;
  std::string message;
  Mode mode = Mode::Copy;
  std::string token;
  std::vector<std::string> paths;
  std::vector<std::string> notification_errors;
};

class Session {
 public:
  Session();
  ~Session();
  Session(const Session&) = delete;
  Session& operator=(const Session&) = delete;

  Result Invoke(const Request& request);
  void Shutdown();
  void AwaitStopped();
  bool Available() const;
  std::string UnavailableReason() const;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

bool Probe(std::string* reason);

}  // namespace native_linux_clipboard

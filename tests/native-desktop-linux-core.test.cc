#include "../native/src/desktop-linux.h"

#include <atomic>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>

namespace {
bool Write(const std::filesystem::path& path, const std::string& contents) {
  const auto parent = path.parent_path();
  if (!parent.empty()) std::filesystem::create_directories(parent);
  std::ofstream stream(path, std::ios::binary);
  stream << contents;
  return stream.good();
}

bool Require(bool condition, const char* message) {
  if (!condition) std::cerr << message << '\n';
  return condition;
}
}

int main(int argc, char** argv) {
  if (argc != 2 || !argv[1][0]) {
    std::cerr << "Expected a private fixture directory.\n";
    return 2;
  }
  const std::filesystem::path root(argv[1]);
  const auto data = root / "data";
  const auto config = root / "config";
  const auto applications = data / "applications";
  const auto text_file = root / "notes.txt";
  const auto unknown_file = root / "unknown.not-registered";
  if (!Write(applications / "desktop-engine-test.desktop",
             "[Desktop Entry]\nType=Application\nName=Desktop Engine Test\n"
             "Exec=/bin/true %f\nMimeType=text/plain;x-scheme-handler/trash;\nNoDisplay=true\n") ||
      !Write(applications / "mimeapps.list",
             "[Default Applications]\ntext/plain=desktop-engine-test.desktop;\n"
             "x-scheme-handler/trash=desktop-engine-test.desktop;\n") ||
      !Write(text_file, "private text fixture\n") ||
      !Write(unknown_file, std::string("\0\x01\x02", 3))) {
    std::cerr << "Could not create private desktop fixtures.\n";
    return 2;
  }
  const std::string data_value = data.string();
  const std::string config_value = config.string();
  setenv("XDG_DATA_HOME", data_value.c_str(), 1);
  setenv("XDG_CONFIG_HOME", config_value.c_str(), 1);
  setenv("XDG_DATA_DIRS", data_value.c_str(), 1);
  setenv("XDG_CONFIG_DIRS", config_value.c_str(), 1);

  bool ok = true;
  const auto capability = ProbeLinuxDesktop();
  ok &= Require(capability, "GIO capability should be available in the test runtime.");

  std::atomic<bool> open{false};
  const auto inspection = RunLinuxDesktop(text_file.string(), false, true, &open);
  ok &= Require(inspection.available, "A private text/plain default handler should be discoverable.");
  ok &= Require(!inspection.submitted, "Inspection must not submit a launch request.");
  ok &= Require(!inspection.requested, "Inspection must not request an application launch.");
  ok &= Require(!inspection.editor, "Linux results must keep editor=false.");

  const auto trash_inspection = RunLinuxDesktop("", true, true, &open);
  ok &= Require(trash_inspection.available, "A private trash URI-scheme handler should be discoverable.");
  ok &= Require(!trash_inspection.submitted, "Trash inspection must not submit a launch request.");
  ok &= Require(!trash_inspection.requested, "Trash inspection must not request an application launch.");
  ok &= Require(!trash_inspection.editor, "Trash inspection must keep editor=false.");

  const auto no_handler = RunLinuxDesktop(unknown_file.string(), false, true, &open);
  ok &= Require(!no_handler.available, "An unassociated binary fixture must have no default handler.");
  ok &= Require(!no_handler.submitted, "A no-handler inspection must not submit a launch request.");

  std::atomic<bool> closed{true};
  const auto cancelled = RunLinuxDesktop(text_file.string(), false, false, &closed);
  ok &= Require(!cancelled.requested, "A closed session must not request an application launch.");
  ok &= Require(!cancelled.submitted, "A closed session must not submit an application launch.");
  ok &= Require(cancelled.cancelled, "A closed session must report its cancellation.");

  std::filesystem::remove_all(root);
  return ok ? 0 : 1;
}

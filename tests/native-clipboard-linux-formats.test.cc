#include "../native/src/clipboard-linux-formats.h"

#include <cstdlib>
#include <string>
#include <vector>

namespace {
void Require(bool value) { if (!value) std::abort(); }
}

int main() {
  using namespace native_linux_clipboard;
  FileSelection selection{{"/tmp/Ordner mit Umlaut-ä.txt", "/tmp/a\\..\\b.txt"}, FileMode::Move};
  std::string gnome;
  Require(EncodeGnomeCopiedFiles(selection, &gnome));
  Require(gnome.rfind("cut\n", 0) == 0);
  FileSelection parsed;
  Require(ParseGnomeCopiedFiles(gnome, &parsed));
  Require(parsed.mode == FileMode::Move);
  Require(parsed.paths == selection.paths);

  std::string uris;
  Require(EncodeUriList(selection.paths, &uris));
  std::vector<std::string> paths;
  Require(ParseUriList("# ignored\r\n" + uris, &paths));
  Require(paths == selection.paths);

  std::string decoded;
  Require(DecodeFileUri("file://localhost/tmp/literal%5Cname.txt", &decoded));
  Require(decoded == "/tmp/literal\\name.txt");
  Require(!DecodeFileUri("file://remote/tmp/file.txt", &decoded));
  Require(!DecodeFileUri("file:///tmp/%00bad", &decoded));
  Require(!DecodeFileUri("file:///tmp/%Q0bad", &decoded));
  Require(!DecodeFileUri("file:///tmp/../outside", &decoded));
  Require(!ParseGnomeCopiedFiles("move\nfile:///tmp/a", &parsed));
  Require(!ParseUriList("file:///tmp/a\nfile://remote/tmp/b\n", &paths));
  Require(!EncodeUriList({}, &uris));
  return 0;
}

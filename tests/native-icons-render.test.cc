#include "../native/src/icons-bridge-win.cc"
#include <cstdio>
#include <stdexcept>

namespace {
void Check(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

HICON ColorIcon(bool alpha, bool legacy24 = false, bool conflictingMask = false) {
  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = 4;
  info.bmiHeader.biHeight = -2;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = legacy24 ? 24 : 32;
  void* raw = nullptr;
  HBITMAP color = CreateDIBSection(nullptr, &info, DIB_RGB_COLORS, &raw, nullptr, 0);
  Check(color && raw, "create color bitmap");
  const uint32_t colors[] = {0, 0, 0x00402010, 0x00ffffff};
  for (size_t row = 0; row < 2; ++row) {
    for (size_t x = 0; x < 4; ++x) {
      const uint32_t color_value = colors[row == 1 && x > 0 ? 4 - x : x];
      if (legacy24) {
        auto* pixel = static_cast<BYTE*>(raw) + row * 12 + x * 3;
        pixel[0] = static_cast<BYTE>(color_value);
        pixel[1] = static_cast<BYTE>(color_value >> 8);
        pixel[2] = static_cast<BYTE>(color_value >> 16);
      } else {
        const uint32_t opacity = !alpha || x == 0 ? 0 : (x == 2 ? 0x80000000 : 0xff000000);
        static_cast<uint32_t*>(raw)[row * 4 + x] = color_value | opacity;
      }
    }
  }
  const auto mask_row = static_cast<unsigned char>(alpha ? (conflictingMask ? 0xf0 : 0) : 0x80);
  const unsigned char mask_bits[] = {mask_row, 0, mask_row, 0};
  HBITMAP mask = CreateBitmap(4, 2, 1, 1, mask_bits);
  ICONINFO icon_info{};
  icon_info.fIcon = TRUE;
  icon_info.hbmColor = color;
  icon_info.hbmMask = mask;
  HICON icon = CreateIconIndirect(&icon_info);
  DeleteObject(mask);
  DeleteObject(color);
  Check(icon != nullptr, "create color icon");
  return icon;
}

void CheckPixel(Gdiplus::Bitmap& bitmap, UINT x, UINT y, BYTE alpha, BYTE red, BYTE green, BYTE blue) {
  Gdiplus::Color color;
  Check(bitmap.GetPixel(x, y, &color) == Gdiplus::Ok, "decode pixel");
  if (color.GetA() != alpha || (alpha &&
      (color.GetR() != red || color.GetG() != green || color.GetB() != blue))) {
    std::fprintf(stderr, "pixel %u,%u: got %u,%u,%u,%u; expected %u,%u,%u,%u\n",
                 x, y, color.GetA(), color.GetR(), color.GetG(), color.GetB(), alpha, red, green, blue);
    throw std::runtime_error("PNG transparency or color changed");
  }
}

void Verify(HICON icon, bool alpha, bool monochrome = false) {
  IconHandle owned;
  owned.value = icon;
  std::vector<unsigned char> png;
  Check(EncodePng(icon, &png), "encode PNG");
  StreamHandle stream;
  Check(CreateStreamOnHGlobal(nullptr, TRUE, &stream.value) == S_OK, "create decoding stream");
  ULONG written = 0;
  Check(stream.value->Write(png.data(), static_cast<ULONG>(png.size()), &written) == S_OK && written == png.size(), "write PNG stream");
  LARGE_INTEGER beginning{};
  Check(stream.value->Seek(beginning, STREAM_SEEK_SET, nullptr) == S_OK, "rewind PNG stream");
  Gdiplus::Bitmap bitmap(stream.value);
  Check(bitmap.GetLastStatus() == Gdiplus::Ok && bitmap.GetWidth() == 4 && bitmap.GetHeight() == 2, "preserve icon dimensions");
  CheckPixel(bitmap, 0, 0, 0, 0, 0, 0);
  CheckPixel(bitmap, 1, 0, 255, 0, 0, 0);
  CheckPixel(bitmap, 2, 0, alpha ? 128 : 255, monochrome ? 255 : 64,
             monochrome ? 255 : 32, monochrome ? 255 : 16);
  CheckPixel(bitmap, 3, 0, 255, 255, 255, 255);
  CheckPixel(bitmap, 0, 1, 0, 0, 0, 0);
  CheckPixel(bitmap, 1, 1, 255, 255, 255, 255);
  CheckPixel(bitmap, 3, 1, 255, 0, 0, 0);
}
}

int main() {
  try {
    GdiPlusSession graphics;
    Check(graphics.result == Gdiplus::Ok, "start image encoder");
    Verify(ColorIcon(true), true);
    Verify(ColorIcon(true, false, true), true);
    Verify(ColorIcon(false), false);
    Verify(ColorIcon(false, true), false);
    const unsigned char monochrome_bits[] = {0x80, 0, 0x80, 0, 0x30, 0, 0x40, 0};
    HBITMAP mask = CreateBitmap(4, 4, 1, 1, monochrome_bits);
    ICONINFO info{};
    info.fIcon = TRUE;
    info.hbmMask = mask;
    HICON monochrome = CreateIconIndirect(&info);
    DeleteObject(mask);
    Check(monochrome != nullptr, "create monochrome icon");
    Verify(monochrome, false, true);
    const DWORD handles_before = GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS);
    for (size_t i = 0; i < 100; ++i) Verify(ColorIcon(true), true);
    Check(GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS) == handles_before, "release GDI handles after repeated encodes");
    std::puts("alpha, opaque black, 24/32-bit legacy masks, monochrome and GDI lifetime passed");
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}

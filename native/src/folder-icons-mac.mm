#include "folder-icons-posix.h"
#import <AppKit/AppKit.h>
#include <mutex>
#include <sys/stat.h>

namespace { std::mutex icon_mutex; }

bool PosixIconsAvailable() { return true; }
std::vector<PosixIconResult> ResolvePosixIcons(const std::vector<PosixIconRequest>& requests,
                                            const std::atomic<bool>& closed) {
  std::lock_guard<std::mutex> lock(icon_mutex);
  std::vector<PosixIconResult> results;
  @autoreleasepool {
    for (const auto& request : requests) {
      PosixIconResult result{request.key, {}};
      struct stat info{};
      if (!closed && !request.path.empty() && lstat(request.path.c_str(), &info) == 0 && !S_ISLNK(info.st_mode)) {
        @try {
          NSString* path = [[NSString alloc] initWithBytes:request.path.data() length:request.path.size() encoding:NSUTF8StringEncoding];
          NSImage* image = path ? [[NSWorkspace sharedWorkspace] iconForFile:path] : nil;
          NSBitmapImageRep* bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:nullptr pixelsWide:32 pixelsHigh:32
              bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
          if (image && bitmap) {
            NSGraphicsContext* context = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
            if (context) {
              [NSGraphicsContext saveGraphicsState];
              @try {
                [NSGraphicsContext setCurrentContext:context];
                [image drawInRect:NSMakeRect(0, 0, 32, 32) fromRect:NSZeroRect operation:NSCompositingOperationCopy fraction:1.0];
              } @finally { [NSGraphicsContext restoreGraphicsState]; }
              NSData* png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
              if (png && png.length <= 65536) {
                const auto* bytes = static_cast<const unsigned char*>(png.bytes);
                result.png.assign(bytes, bytes + png.length);
              }
            }
          }
        } @catch (NSException* exception) { (void)exception; result.png.clear(); }
      }
      results.push_back(std::move(result));
    }
  }
  return results;
}

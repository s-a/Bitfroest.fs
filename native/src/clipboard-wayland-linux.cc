#include "clipboard-wayland-linux.h"

#include "clipboard-linux-formats.h"

#include <wayland-client-core.h>
#include <wayland-util.h>

#include <dlfcn.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <future>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <thread>
#include <utility>

namespace native_linux_wayland_clipboard {
namespace {
using native_linux_clipboard::FileMode;
using native_linux_clipboard::FileSelection;
using native_linux_clipboard::Mode;
using native_linux_clipboard::Operation;
using native_linux_clipboard::Request;
using native_linux_clipboard::Result;

constexpr size_t kMaxClipboardBytes = 1048576;
constexpr size_t kMaxClipboardPaths = 1024;
constexpr int kTransferTimeoutMs = 10000;
constexpr uint32_t kMarshalDestroy = 1u;
constexpr char kUriListMime[] = "text/uri-list";
constexpr char kGnomeFilesMime[] = "x-special/gnome-copied-files";

class ScopedSigpipeBlock {
 public:
  ScopedSigpipeBlock() {
    sigemptyset(&set_);
    sigaddset(&set_, SIGPIPE);
    if (pthread_sigmask(SIG_BLOCK, &set_, &old_mask_) != 0) return;
    active_ = true;
    sigset_t pending;
    if (sigpending(&pending) == 0) had_pending_ = sigismember(&pending, SIGPIPE) == 1;
  }
  ~ScopedSigpipeBlock() {
    if (!active_) return;
    if (!had_pending_) {
      sigset_t pending;
      if (sigpending(&pending) == 0 && sigismember(&pending, SIGPIPE) == 1) {
        const timespec no_wait{0, 0};
        while (sigtimedwait(&set_, nullptr, &no_wait) < 0 && errno == EINTR) {}
      }
    }
    (void)pthread_sigmask(SIG_SETMASK, &old_mask_, nullptr);
  }
  bool active() const { return active_; }

 private:
  sigset_t set_{};
  sigset_t old_mask_{};
  bool active_ = false;
  bool had_pending_ = false;
};

const wl_interface* g_manager_types[3]{};
const wl_message g_manager_requests[] = {
    {"create_data_source", "n", &g_manager_types[0]},
    {"get_data_device", "no", &g_manager_types[1]},
    {"destroy", "", nullptr},
};
const wl_interface* g_device_types[1]{};
const wl_message g_device_requests[] = {
    {"set_selection", "?o", &g_device_types[0]},
    {"destroy", "", nullptr},
    {"set_primary_selection", "?o", &g_device_types[0]},
};
const wl_interface* g_device_event_types[2]{};
const wl_message g_device_events[] = {
    {"data_offer", "n", &g_device_event_types[0]},
    {"selection", "?o", &g_device_event_types[1]},
    {"finished", "", nullptr},
    {"primary_selection", "?o", &g_device_event_types[1]},
};
const wl_message g_source_requests[] = {
    {"offer", "s", nullptr},
    {"destroy", "", nullptr},
};
const wl_message g_source_events[] = {
    {"send", "sh", nullptr},
    {"cancelled", "", nullptr},
};
const wl_message g_offer_requests[] = {
    {"receive", "sh", nullptr},
    {"destroy", "", nullptr},
};
const wl_message g_offer_events[] = {
    {"offer", "s", nullptr},
};
const wl_interface g_source_interface = {"ext_data_control_source_v1", 1, 2, g_source_requests, 2, g_source_events};
const wl_interface g_offer_interface = {"ext_data_control_offer_v1", 1, 2, g_offer_requests, 1, g_offer_events};
const wl_interface g_device_interface = {"ext_data_control_device_v1", 1, 3, g_device_requests, 4, g_device_events};
const wl_interface g_manager_interface = {"ext_data_control_manager_v1", 1, 3, g_manager_requests, 0, nullptr};

const wl_interface* g_wlr_manager_types[3]{};
const wl_message g_wlr_manager_requests[] = {
    {"create_data_source", "n", &g_wlr_manager_types[0]},
    {"get_data_device", "no", &g_wlr_manager_types[1]},
    {"destroy", "", nullptr},
};
const wl_interface* g_wlr_device_types[1]{};
const wl_message g_wlr_device_requests[] = {
    {"set_selection", "?o", &g_wlr_device_types[0]},
    {"destroy", "", nullptr},
    {"set_primary_selection", "2?o", &g_wlr_device_types[0]},
};
const wl_interface* g_wlr_device_event_types[2]{};
const wl_message g_wlr_device_events[] = {
    {"data_offer", "n", &g_wlr_device_event_types[0]},
    {"selection", "?o", &g_wlr_device_event_types[1]},
    {"finished", "", nullptr},
    {"primary_selection", "2?o", &g_wlr_device_event_types[1]},
};
const wl_message g_wlr_source_requests[] = {{"offer", "s", nullptr}, {"destroy", "", nullptr}};
const wl_message g_wlr_source_events[] = {{"send", "sh", nullptr}, {"cancelled", "", nullptr}};
const wl_message g_wlr_offer_requests[] = {{"receive", "sh", nullptr}, {"destroy", "", nullptr}};
const wl_message g_wlr_offer_events[] = {{"offer", "s", nullptr}};
const wl_interface g_wlr_source_interface = {"zwlr_data_control_source_v1", 1, 2, g_wlr_source_requests, 2, g_wlr_source_events};
const wl_interface g_wlr_offer_interface = {"zwlr_data_control_offer_v1", 1, 2, g_wlr_offer_requests, 1, g_wlr_offer_events};
const wl_interface g_wlr_device_interface = {"zwlr_data_control_device_v1", 2, 3, g_wlr_device_requests, 4, g_wlr_device_events};
const wl_interface g_wlr_manager_interface = {"zwlr_data_control_manager_v1", 2, 3, g_wlr_manager_requests, 0, nullptr};

struct Api {
  void* library = nullptr;
  wl_display* (*display_connect)(const char*) = nullptr;
  wl_display* (*display_connect_to_fd)(int) = nullptr;
  void (*display_disconnect)(wl_display*) = nullptr;
  int (*display_get_error)(wl_display*) = nullptr;
  int (*display_dispatch_pending)(wl_display*) = nullptr;
  int (*display_flush)(wl_display*) = nullptr;
  int (*display_get_fd)(wl_display*) = nullptr;
  int (*display_prepare_read)(wl_display*) = nullptr;
  int (*display_read_events)(wl_display*) = nullptr;
  void (*display_cancel_read)(wl_display*) = nullptr;
  wl_proxy* (*proxy_marshal_flags)(wl_proxy*, uint32_t, const wl_interface*, uint32_t, uint32_t, ...) = nullptr;
  int (*proxy_add_listener)(wl_proxy*, void (**)(void), void*) = nullptr;
  uint32_t (*proxy_get_version)(wl_proxy*) = nullptr;
  void (*proxy_destroy)(wl_proxy*) = nullptr;
  const wl_interface* registry_interface = nullptr;
  const wl_interface* seat_interface = nullptr;
  const wl_interface* callback_interface = nullptr;

  ~Api() { if (library) dlclose(library); }

  template <typename T> bool Load(T* target, const char* name) {
    *target = reinterpret_cast<T>(dlsym(library, name));
    return *target != nullptr;
  }

  bool Open() {
    // Core interface metadata is process-global, so retain the shared object's
    // mapping even when this session drops its own dlopen reference.
    library = dlopen("libwayland-client.so.0", RTLD_NOW | RTLD_LOCAL | RTLD_NODELETE);
    if (!library) return false;
    return Load(&display_connect, "wl_display_connect") &&
        Load(&display_connect_to_fd, "wl_display_connect_to_fd") &&
        Load(&display_disconnect, "wl_display_disconnect") &&
        Load(&display_get_error, "wl_display_get_error") &&
        Load(&display_dispatch_pending, "wl_display_dispatch_pending") &&
        Load(&display_flush, "wl_display_flush") &&
        Load(&display_get_fd, "wl_display_get_fd") &&
        Load(&display_prepare_read, "wl_display_prepare_read") &&
        Load(&display_read_events, "wl_display_read_events") &&
        Load(&display_cancel_read, "wl_display_cancel_read") &&
        Load(&proxy_marshal_flags, "wl_proxy_marshal_flags") &&
        Load(&proxy_add_listener, "wl_proxy_add_listener") &&
        Load(&proxy_get_version, "wl_proxy_get_version") &&
        Load(&proxy_destroy, "wl_proxy_destroy") &&
        LoadData(&registry_interface, "wl_registry_interface") &&
        LoadData(&seat_interface, "wl_seat_interface") &&
        LoadData(&callback_interface, "wl_callback_interface");
  }

  template <typename T> bool LoadData(T* target, const char* name) {
    *target = reinterpret_cast<T>(dlsym(library, name));
    return *target != nullptr;
  }

  const wl_interface* Registry() const { return registry_interface; }
  const wl_interface* Seat() const { return seat_interface; }
};

Result Failure(const char* code, const char* message) {
  Result result;
  result.code = code;
  result.message = message;
  return result;
}

std::string PathIdentity(const std::string& path) {
  struct stat identity{};
  if (lstat(path.c_str(), &identity) != 0) return "missing:" + std::to_string(errno);
  return std::to_string(static_cast<uint64_t>(identity.st_dev)) + ":" +
      std::to_string(static_cast<uint64_t>(identity.st_ino)) + ":" +
      std::to_string(static_cast<uint64_t>(identity.st_mode & S_IFMT)) + ":" +
      std::to_string(static_cast<int64_t>(identity.st_ctim.tv_sec)) + ":" +
      std::to_string(static_cast<int64_t>(identity.st_ctim.tv_nsec));
}

std::string Token(uint64_t generation, const std::vector<std::string>& paths, Mode mode) {
  uint64_t hash = 1469598103934665603ull;
  auto mix = [&hash](unsigned char value) { hash = (hash ^ value) * 1099511628211ull; };
  mix(mode == Mode::Move ? 'm' : 'c');
  for (const auto& path : paths) {
    for (unsigned char value : path) mix(value);
    mix(0xff);
    const std::string identity = PathIdentity(path);
    for (unsigned char value : identity) mix(value);
    mix(0xfe);
  }
  std::ostringstream stream;
  stream << "wayland:" << generation << ':' << std::hex << hash;
  return stream.str();
}

bool WriteAll(int fd, const std::string& data, const std::shared_ptr<std::atomic<bool>>& stopping) {
  ScopedSigpipeBlock sigpipe_block;
  if (!sigpipe_block.active()) return false;
  const int flags = fcntl(fd, F_GETFL, 0);
  if (flags >= 0) (void)fcntl(fd, F_SETFL, flags | O_NONBLOCK);
  size_t offset = 0;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
  while (offset < data.size() && !stopping->load()) {
    const ssize_t written = write(fd, data.data() + offset, data.size() - offset);
    if (written > 0) { offset += static_cast<size_t>(written); continue; }
    if (written < 0 && errno == EINTR) continue;
    if (written < 0 && errno != EAGAIN && errno != EWOULDBLOCK) return false;
    if (std::chrono::steady_clock::now() >= deadline) return false;
    pollfd descriptor{fd, POLLOUT, 0};
    (void)poll(&descriptor, 1, 100);
  }
  return offset == data.size();
}
}  // namespace

class Session::Impl {
 public:
  Impl() : stopping_(std::make_shared<std::atomic<bool>>(false)), joined_(joined_promise_.get_future().share()) {
    worker_ = std::thread(&Impl::Run, this);
  }
  ~Impl() { Shutdown(); AwaitStopped(); }

  Result Invoke(const Request& request) {
    auto item = std::make_shared<Command>();
    item->request = request;
    auto future = item->promise.get_future();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (stopping_->load()) return Failure("SessionClosed", "The Wayland clipboard session is closed.");
      commands_.push_back(item);
    }
    changed_.notify_one();
    return future.get();
  }

  void Shutdown() {
    stopping_->store(true);
    {
      std::lock_guard<std::mutex> lock(connection_mutex_);
      if (shutdown_fd_ >= 0) {
        (void)shutdown(shutdown_fd_, SHUT_RDWR);
        close(shutdown_fd_);
        shutdown_fd_ = -1;
      }
    }
    changed_.notify_all();
  }

  void AwaitStopped() {
    std::lock_guard<std::mutex> lock(join_mutex_);
    if (worker_.joinable() && worker_.get_id() != std::this_thread::get_id()) worker_.join();
  }

  bool Available() const { std::lock_guard<std::mutex> lock(mutex_); return available_; }
  std::string UnavailableReason() const { std::lock_guard<std::mutex> lock(mutex_); return reason_; }

 private:
  enum class Protocol { Ext, Wlr };
  struct Command { Request request; std::promise<Result> promise; };
  struct Offer { wl_proxy* proxy = nullptr; std::set<std::string> mime_types; };
  struct Source { std::string uri_list; std::string gnome_files; };

  static void RegistryGlobal(void* data, wl_proxy*, uint32_t name, const char* interface, uint32_t version) {
    auto* self = static_cast<Impl*>(data);
    if (std::strcmp(interface, "ext_data_control_manager_v1") == 0 && !self->manager_name_) {
      self->manager_name_ = name; self->manager_version_ = std::min(version, 1u); self->protocol_ = Protocol::Ext;
    } else if (std::strcmp(interface, "zwlr_data_control_manager_v1") == 0 && !self->wlr_manager_name_) {
      self->wlr_manager_name_ = name; self->wlr_manager_version_ = std::min(version, 2u);
    } else if (std::strcmp(interface, "wl_seat") == 0 && !self->seat_name_) {
      self->seat_name_ = name; self->seat_version_ = std::min(version, 1u);
    }
  }
  static void RegistryRemove(void*, wl_proxy*, uint32_t) {}
  static void SyncDone(void* data, wl_proxy*, uint32_t) { *static_cast<bool*>(data) = true; }

  static void OfferMime(void* data, wl_proxy*, const char* mime) {
    auto* offer = static_cast<Offer*>(data);
    if (offer && mime) offer->mime_types.emplace(mime);
  }

  static void DeviceDataOffer(void* data, wl_proxy*, wl_proxy* proxy) {
    auto* self = static_cast<Impl*>(data);
    auto item = std::make_unique<Offer>();
    item->proxy = proxy;
    self->offers_[proxy] = std::move(item);
    Offer* offer = self->offers_[proxy].get();
    self->api_->proxy_add_listener(proxy, reinterpret_cast<void (**)(void)>(OfferListener), offer);
  }
  static void DeviceSelection(void* data, wl_proxy*, wl_proxy* offer) {
    auto* self = static_cast<Impl*>(data);
    wl_proxy* previous = self->selection_offer_;
    self->selection_offer_ = offer;
    ++self->generation_;
    if (!offer) self->own_selection_ = false;
    if (previous && previous != offer) {
      auto found = self->offers_.find(previous);
      if (found != self->offers_.end()) {
        self->api_->proxy_marshal_flags(previous, 1, nullptr, 1, kMarshalDestroy);
        self->offers_.erase(found);
      }
    }
  }
  static void DeviceFinished(void* data, wl_proxy*) {
    auto* self = static_cast<Impl*>(data);
    self->own_selection_ = false;
    ++self->generation_;
  }
  static void DevicePrimarySelection(void*, wl_proxy*, wl_proxy*) {}

  static void SourceSend(void* data, wl_proxy* proxy, const char* mime, int fd) {
    auto* self = static_cast<Impl*>(data);
    auto it = self->sources_.find(proxy);
    if (it == self->sources_.end() || !mime) { close(fd); return; }
    const std::string* payload = nullptr;
    if (std::strcmp(mime, kGnomeFilesMime) == 0) payload = &it->second.gnome_files;
    else if (std::strcmp(mime, kUriListMime) == 0) payload = &it->second.uri_list;
    if (!payload) { close(fd); return; }
    auto data_copy = *payload;
    auto stopping = self->stopping_;
    self->AddSend(std::thread([fd, data_copy = std::move(data_copy), stopping]() { (void)WriteAll(fd, data_copy, stopping); close(fd); }));
  }
  static void SourceCancelled(void* data, wl_proxy* proxy) {
    auto* self = static_cast<Impl*>(data);
    if (proxy == self->own_source_) {
      self->own_selection_ = false;
      self->own_source_ = nullptr;
      self->own_paths_.clear();
      self->own_path_identities_.clear();
      self->own_token_.clear();
      self->sources_.erase(proxy);
      self->api_->proxy_marshal_flags(proxy, 1, nullptr, 1, kMarshalDestroy);
      ++self->generation_;
    }
  }

  void AddSend(std::thread thread) {
    std::lock_guard<std::mutex> lock(send_mutex_);
    send_threads_.push_back(std::move(thread));
  }

  bool Connect() {
    auto api = std::make_unique<Api>();
    if (!api->Open()) { SetUnavailable("WaylandClientLibraryUnavailable"); return false; }
    api_ = std::move(api);
    const char* socket_override = std::getenv("WAYLAND_SOCKET");
    if (socket_override && *socket_override) {
      SetUnavailable("WaylandSocketSessionsUnsupported"); return false;
    }
    const char* display_name = std::getenv("WAYLAND_DISPLAY");
    if (!display_name || !*display_name) {
      SetUnavailable("WaylandSessionUnavailable"); return false;
    }
    if (socket_override) {
      const char* runtime_directory = std::getenv("XDG_RUNTIME_DIR");
      if (display_name[0] != '/' && (!runtime_directory || !*runtime_directory)) {
        SetUnavailable("WaylandSessionUnavailable"); return false;
      }
      const std::string path = display_name[0] == '/' ? display_name : std::string(runtime_directory) + "/" + display_name;
      sockaddr_un address{};
      if (path.size() >= sizeof(address.sun_path)) { SetUnavailable("WaylandSessionUnavailable"); return false; }
      const int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
      if (fd < 0) { SetUnavailable("WaylandConnectionUnavailable"); return false; }
      address.sun_family = AF_UNIX;
      std::memcpy(address.sun_path, path.c_str(), path.size() + 1);
      if (connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
        close(fd); SetUnavailable("WaylandConnectionUnavailable"); return false;
      }
      display_ = api_->display_connect_to_fd(fd);
      if (!display_) close(fd);
    } else display_ = api_->display_connect(nullptr);
    if (!display_) { SetUnavailable("WaylandConnectionUnavailable"); return false; }
    {
      std::lock_guard<std::mutex> lock(connection_mutex_);
      shutdown_fd_ = fcntl(api_->display_get_fd(display_), F_DUPFD_CLOEXEC, 3);
      if (stopping_->load() && shutdown_fd_ >= 0) (void)shutdown(shutdown_fd_, SHUT_RDWR);
    }
    const wl_interface* registry_interface = api_->Registry();
    const wl_interface* seat_interface = api_->Seat();
    if (!registry_interface || !seat_interface) { SetUnavailable("WaylandCoreProtocolUnavailable"); return false; }
    registry_ = api_->proxy_marshal_flags(reinterpret_cast<wl_proxy*>(display_), 1, registry_interface, 1, 0, nullptr);
    if (!registry_) { SetUnavailable("WaylandRegistryUnavailable"); return false; }
    if (api_->proxy_add_listener(registry_, RegistryListener, this) != 0) {
      SetUnavailable("WaylandRegistryListenerUnavailable"); return false;
    }
    if (!SyncRoundtrip()) {
      SetUnavailable("WaylandConnectionUnavailable"); return false;
    }
    if (!manager_name_ && !wlr_manager_name_) { SetUnavailable("WaylandDataControlUnavailable"); return false; }
    if (!seat_name_) { SetUnavailable("WaylandSeatUnavailable"); return false; }
    static std::once_flag protocol_types_once;
    std::call_once(protocol_types_once, [seat_interface]() {
      g_manager_types[0] = &g_source_interface;
      g_manager_types[1] = &g_device_interface;
      g_manager_types[2] = seat_interface;
      g_device_types[0] = &g_source_interface;
      g_device_event_types[0] = &g_offer_interface;
      g_device_event_types[1] = &g_offer_interface;
      g_wlr_manager_types[0] = &g_wlr_source_interface;
      g_wlr_manager_types[1] = &g_wlr_device_interface;
      g_wlr_manager_types[2] = seat_interface;
      g_wlr_device_types[0] = &g_wlr_source_interface;
      g_wlr_device_event_types[0] = &g_wlr_offer_interface;
      g_wlr_device_event_types[1] = &g_wlr_offer_interface;
    });
    const wl_interface* manager_interface = &g_manager_interface;
    if (!manager_name_) {
      manager_name_ = wlr_manager_name_;
      manager_version_ = wlr_manager_version_;
      protocol_ = Protocol::Wlr;
      manager_interface = &g_wlr_manager_interface;
    }
    manager_ = api_->proxy_marshal_flags(registry_, 0, manager_interface, manager_version_, 0,
        manager_name_, manager_interface->name, manager_version_, nullptr);
    seat_ = api_->proxy_marshal_flags(registry_, 0, seat_interface, seat_version_, 0,
        seat_name_, seat_interface->name, seat_version_, nullptr);
    if (!manager_ || !seat_) { SetUnavailable("WaylandDataControlBindFailed"); return false; }
    const wl_interface* device_interface = protocol_ == Protocol::Wlr ? &g_wlr_device_interface : &g_device_interface;
    device_ = api_->proxy_marshal_flags(manager_, 1, device_interface, protocol_ == Protocol::Wlr ? manager_version_ : 1u, 0, nullptr, seat_);
    if (!device_ || api_->proxy_add_listener(device_, DeviceListener, this) != 0) {
      SetUnavailable("WaylandDataControlDeviceUnavailable"); return false;
    }
    if (!SyncRoundtrip()) {
      SetUnavailable("WaylandDataControlDeviceUnavailable"); return false;
    }
    { std::lock_guard<std::mutex> lock(mutex_); available_ = true; reason_.clear(); }
    return true;
  }

  void SetUnavailable(std::string reason) {
    std::lock_guard<std::mutex> lock(mutex_);
    available_ = false;
    reason_ = std::move(reason);
  }

  bool SyncRoundtrip() {
    bool done = false;
    wl_proxy* callback = api_->proxy_marshal_flags(
        reinterpret_cast<wl_proxy*>(display_), 0, api_->callback_interface, 1, 0, nullptr);
    if (!callback || api_->proxy_add_listener(callback, CallbackListener, &done) != 0) {
      if (callback) api_->proxy_destroy(callback);
      return false;
    }
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    bool success = false;
    while (!done && !stopping_->load() && std::chrono::steady_clock::now() < deadline) {
      while (api_->display_prepare_read(display_) != 0) {
        if (api_->display_dispatch_pending(display_) < 0 || stopping_->load()) goto finished;
      }
      const int flushed = api_->display_flush(display_);
      const bool needs_write = flushed < 0 && errno == EAGAIN;
      if (flushed < 0 && !needs_write) {
        api_->display_cancel_read(display_);
        goto finished;
      }
      pollfd descriptor{api_->display_get_fd(display_), static_cast<short>(POLLIN | (needs_write ? POLLOUT : 0)), 0};
      const int ready = poll(&descriptor, 1, 100);
      if (ready < 0 && errno != EINTR) {
        api_->display_cancel_read(display_);
        goto finished;
      }
      if (ready == 0 || (ready < 0 && errno == EINTR)) {
        api_->display_cancel_read(display_);
        continue;
      }
      if (descriptor.revents & POLLIN) {
        if (api_->display_read_events(display_) < 0) goto finished;
      } else {
        api_->display_cancel_read(display_);
        if (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) goto finished;
        continue;
      }
      if (api_->display_dispatch_pending(display_) < 0) goto finished;
    }
    success = done && !stopping_->load();
  finished:
    api_->proxy_destroy(callback);
    return success;
  }

  void Run() {
    const bool connected = Connect();
    std::vector<std::shared_ptr<Command>> pending;
    while (!stopping_->load()) {
      {
        std::lock_guard<std::mutex> lock(mutex_);
        pending.assign(commands_.begin(), commands_.end());
        commands_.clear();
      }
      for (const auto& command : pending) {
        Result result;
        if (!connected) result = Failure("UnsupportedOperation", reason_.c_str());
        else if (stopping_->load()) result = Failure("SessionClosed", "The Wayland clipboard session is closed.");
        else result = Execute(command->request);
        try { command->promise.set_value(std::move(result)); } catch (...) {}
      }
      if (!connected) {
        std::unique_lock<std::mutex> lock(mutex_);
        changed_.wait_for(lock, std::chrono::milliseconds(50), [&] { return stopping_->load() || !commands_.empty(); });
        continue;
      }
      if (api_->display_dispatch_pending(display_) < 0) { SetUnavailable("WaylandConnectionLost"); stopping_->store(true); break; }
      if (api_->display_flush(display_) < 0 && errno != EAGAIN) { SetUnavailable("WaylandConnectionLost"); stopping_->store(true); break; }
      pollfd descriptor{api_->display_get_fd(display_), POLLIN, 0};
      const int ready = poll(&descriptor, 1, 50);
      if (ready > 0 && (descriptor.revents & (POLLIN | POLLHUP | POLLERR))) {
        if (!SyncRoundtrip()) {
          SetUnavailable("WaylandConnectionLost");
          stopping_->store(true);
          break;
        }
      }
    }
    stopping_->store(true);
    std::deque<std::shared_ptr<Command>> abandoned;
    { std::lock_guard<std::mutex> lock(mutex_); abandoned.swap(commands_); }
    for (const auto& command : abandoned) {
      try { command->promise.set_value(Failure("SessionClosed", "The Wayland clipboard session is closed.")); } catch (...) {}
    }
    Cleanup();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stopped_ = true;
    }
    changed_.notify_all();
  }

  Result Execute(const Request& request) {
    // Drain ownership-change events before evaluating a token. The protocol's
    // source.cancelled event is the only authoritative signal for this source.
    if (display_ && !SyncRoundtrip()) {
      SetUnavailable("WaylandConnectionLost");
      return Failure("ClipboardConnectionLost", "The Wayland clipboard connection was lost.");
    }
    switch (request.operation) {
      case Operation::Read: return Read();
      case Operation::Write: return Write(request);
      case Operation::Acknowledge: return Acknowledge(request, false);
      case Operation::Cancel: return Acknowledge(request, true);
    }
    return Failure("InvalidRequest", "The Wayland clipboard operation is invalid.");
  }

  Result Read() {
    if (own_selection_ && own_source_) {
      if (OwnPathIdentityChanged()) {
        CaptureOwnIdentities();
        ++generation_;
        own_token_ = Token(generation_, own_paths_, own_mode_);
      }
      Result result; result.ok = true; result.available = true; result.paths = own_paths_;
      result.mode = own_mode_; result.token = own_token_; return result;
    }
    if (!selection_offer_) { Result result; result.ok = true; result.available = true; return result; }
    wl_proxy* captured_offer = selection_offer_;
    auto found = offers_.find(captured_offer);
    if (found == offers_.end()) return Failure("ClipboardChanged", "The Wayland file selection changed.");
    const bool gnome = found->second->mime_types.count(kGnomeFilesMime) != 0;
    const char* mime = gnome ? kGnomeFilesMime : found->second->mime_types.count(kUriListMime) ? kUriListMime : nullptr;
    if (!mime) { Result result; result.ok = true; result.available = true; return result; }
    const auto selection_generation = generation_;
    std::string bytes;
    bool connection_lost = false;
    if (!Receive(captured_offer, mime, &bytes, &connection_lost)) {
      if (connection_lost) {
        SetUnavailable("WaylandConnectionLost");
        return Failure("ClipboardConnectionLost", "The Wayland clipboard connection was lost.");
      }
      return Failure("ClipboardReadFailed", "The Wayland clipboard data could not be read.");
    }
    if (!SyncRoundtrip()) return Failure("ClipboardConnectionLost", "The Wayland clipboard connection was lost.");
    if (selection_generation != generation_ || captured_offer != selection_offer_) return Failure("ClipboardChanged", "The Wayland file selection changed.");
    std::vector<std::string> paths;
    Mode mode = Mode::Copy;
    bool parsed = false;
    if (gnome) {
      FileSelection decoded;
      parsed = native_linux_clipboard::ParseGnomeCopiedFiles(bytes, &decoded);
      if (parsed) { paths = std::move(decoded.paths); mode = decoded.mode == FileMode::Move ? Mode::Move : Mode::Copy; }
    } else parsed = native_linux_clipboard::ParseUriList(bytes, &paths);
    if (!parsed) return Failure("InvalidClipboardData", "The Wayland file selection is invalid.");
    Result result; result.ok = true; result.available = true; result.paths = std::move(paths); result.mode = mode;
    result.token = Token(selection_generation, result.paths, mode);
    return result;
  }

  Result Write(const Request& request) {
    if (request.paths.empty() || request.paths.size() > kMaxClipboardPaths) return Failure("InvalidRequest", "The Wayland file selection is invalid.");
    FileSelection selection;
    selection.paths = request.paths;
    selection.mode = request.mode == Mode::Move ? FileMode::Move : FileMode::Copy;
    std::string uris, gnome;
    if (!native_linux_clipboard::EncodeUriList(selection.paths, &uris) || !native_linux_clipboard::EncodeGnomeCopiedFiles(selection, &gnome)) return Failure("InvalidRequest", "The Wayland file selection is invalid.");
    wl_proxy* previous_source = own_source_;
    const wl_interface* source_interface = protocol_ == Protocol::Wlr ? &g_wlr_source_interface : &g_source_interface;
    wl_proxy* source = api_->proxy_marshal_flags(manager_, 0, source_interface, 1, 0, nullptr);
    if (!source) return Failure("ResourceExhausted", "The Wayland clipboard source could not be created.");
    auto [where, inserted] = sources_.emplace(source, Source{std::move(uris), std::move(gnome)});
    if (!inserted) { api_->proxy_destroy(source); return Failure("ResourceExhausted", "The Wayland clipboard source could not be retained."); }
    if (api_->proxy_add_listener(source, SourceListener, this) != 0) {
      DestroySource(source); return Failure("WaylandDataControlBindFailed", "The Wayland clipboard source could not be monitored.");
    }
    api_->proxy_marshal_flags(source, 0, nullptr, 1, 0, kUriListMime);
    api_->proxy_marshal_flags(source, 0, nullptr, 1, 0, kGnomeFilesMime);
    api_->proxy_marshal_flags(device_, 0, nullptr, 1, 0, source);
    if (api_->display_flush(display_) < 0) {
      DestroySource(source);
      return Failure("ClipboardWriteFailed", "The Wayland file selection could not be published.");
    }
    ++generation_;
    own_source_ = source; own_paths_ = request.paths; own_mode_ = request.mode; own_selection_ = true;
    CaptureOwnIdentities();
    own_token_ = Token(generation_, own_paths_, own_mode_);
    if (previous_source && previous_source != source) DestroySource(previous_source);
    Result result; result.ok = true; result.available = true; result.paths = own_paths_; result.mode = own_mode_; result.token = own_token_;
    return result;
  }

  Result Acknowledge(const Request& request, bool cancel) {
    if (!own_selection_ || request.token.empty() || request.token != own_token_ || request.mode != own_mode_ || request.paths != own_paths_) {
      Result result; result.ok = true; result.available = true; result.matched = false; return result;
    }
    if (!cancel) {
      if (request.mode != Mode::Move || request.remaining_paths.size() > request.paths.size()) return Failure("InvalidRequest", "The Wayland move acknowledgement is invalid.");
      std::set<std::string> original(request.paths.begin(), request.paths.end());
      for (const auto& path : request.remaining_paths) if (!original.count(path)) return Failure("InvalidRequest", "The Wayland move acknowledgement is invalid.");
      if (!OwnPathIdentitiesMatch(request.remaining_paths)) {
        Result result; result.ok = true; result.available = true; result.matched = false; return result;
      }
      if (!request.remaining_paths.empty()) {
        if (!own_source_) {
          Result result; result.ok = true; result.available = true; result.matched = false; return result;
        }
        FileSelection selection;
        selection.paths = request.remaining_paths;
        selection.mode = FileMode::Move;
        Source replacement;
        if (!native_linux_clipboard::EncodeUriList(selection.paths, &replacement.uri_list) ||
            !native_linux_clipboard::EncodeGnomeCopiedFiles(selection, &replacement.gnome_files)) {
          return Failure("InvalidRequest", "The Wayland move acknowledgement is invalid.");
        }
        const auto source = sources_.find(own_source_);
        if (source == sources_.end()) {
          Result result; result.ok = true; result.available = true; result.matched = false; return result;
        }
        source->second = std::move(replacement);
        ++generation_;
        own_paths_ = request.remaining_paths;
        own_mode_ = Mode::Move;
        CaptureOwnIdentities();
        own_token_ = Token(generation_, own_paths_, own_mode_);
        Result result; result.ok = true; result.available = true; result.matched = true;
        result.paths = own_paths_; result.mode = own_mode_; result.token = own_token_;
        return result;
      }
    }
    ClearOwned();
    Result result; result.ok = true; result.available = true; result.matched = true; return result;
  }

  bool Receive(wl_proxy* offer, const char* mime, std::string* output, bool* connection_lost) {
    if (connection_lost) *connection_lost = false;
    int descriptors[2];
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, descriptors) != 0) return false;
    const int flags = fcntl(descriptors[0], F_GETFL, 0);
    if (flags >= 0) (void)fcntl(descriptors[0], F_SETFL, flags | O_NONBLOCK);
    api_->proxy_marshal_flags(offer, 0, nullptr, 1, 0, mime, descriptors[1]);
    if (api_->display_flush(display_) < 0) { close(descriptors[0]); close(descriptors[1]); return false; }
    close(descriptors[1]);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(kTransferTimeoutMs);
    std::string data;
    char buffer[8192];
    bool complete = false;
    while (!stopping_->load() && !complete && std::chrono::steady_clock::now() < deadline) {
      while (api_->display_prepare_read(display_) != 0) {
        if (api_->display_dispatch_pending(display_) < 0) {
          if (connection_lost) *connection_lost = true;
          goto finished;
        }
        if (stopping_->load()) goto finished;
      }
      const int flushed = api_->display_flush(display_);
      const bool needs_write = flushed < 0 && errno == EAGAIN;
      if (flushed < 0 && !needs_write) {
        api_->display_cancel_read(display_);
        if (connection_lost) *connection_lost = true;
        break;
      }
      pollfd descriptors_to_poll[2] = {
          {descriptors[0], static_cast<short>(POLLIN | POLLHUP), 0},
          {api_->display_get_fd(display_), static_cast<short>(POLLIN | POLLHUP | POLLERR | POLLNVAL | (needs_write ? POLLOUT : 0)), 0}};
      const int ready = poll(descriptors_to_poll, 2, 100);
      if (ready < 0) {
        api_->display_cancel_read(display_);
        if (errno == EINTR) continue;
        if (connection_lost) *connection_lost = true;
        break;
      }
      if (ready == 0) {
        api_->display_cancel_read(display_);
      } else if (descriptors_to_poll[1].revents & POLLIN) {
        if (api_->display_read_events(display_) < 0 || api_->display_dispatch_pending(display_) < 0) {
          if (connection_lost) *connection_lost = true;
          break;
        }
      } else {
        api_->display_cancel_read(display_);
        if (descriptors_to_poll[1].revents & (POLLHUP | POLLERR | POLLNVAL)) {
          if (connection_lost) *connection_lost = true;
          break;
        }
      }
      if (descriptors_to_poll[1].revents & (POLLHUP | POLLERR | POLLNVAL)) {
        if (connection_lost) *connection_lost = true;
        break;
      }
      if (descriptors_to_poll[0].revents & (POLLIN | POLLHUP)) {
        const ssize_t count = recv(descriptors[0], buffer, sizeof(buffer), 0);
        if (count > 0) {
          if (data.size() + static_cast<size_t>(count) > kMaxClipboardBytes) break;
          data.append(buffer, static_cast<size_t>(count));
        } else if (count == 0) {
          complete = true;
        } else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
          break;
        }
      }
    }
  finished:
    close(descriptors[0]);
    if (!complete || stopping_->load()) return false;
    *output = std::move(data);
    return true;
  }

  void ClearOwned() {
    // Destroying this source lets the compositor clear it only if this exact
    // source is still the active selection. A NULL selection request would
    // unconditionally clear a newer selection owned by another client.
    if (own_source_) { DestroySource(own_source_); own_source_ = nullptr; }
    if (display_) (void)api_->display_flush(display_);
    own_selection_ = false;
    own_paths_.clear();
    own_path_identities_.clear();
    own_token_.clear();
    ++generation_;
  }

  void CaptureOwnIdentities() {
    own_path_identities_.clear();
    for (const auto& path : own_paths_) own_path_identities_.emplace(path, PathIdentity(path));
  }

  bool OwnPathIdentitiesMatch(const std::vector<std::string>& paths) const {
    for (const auto& path : paths) {
      const auto found = own_path_identities_.find(path);
      if (found == own_path_identities_.end() || found->second != PathIdentity(path)) return false;
    }
    return true;
  }

  bool OwnPathIdentityChanged() const {
    for (const auto& path : own_paths_) {
      const auto found = own_path_identities_.find(path);
      if (found == own_path_identities_.end()) return true;
      const std::string current = PathIdentity(path);
      if (current != found->second && current.rfind("missing:", 0) != 0) return true;
    }
    return false;
  }

  void DestroySource(wl_proxy* source) {
    auto found = sources_.find(source);
    if (found != sources_.end()) sources_.erase(found);
    if (api_ && source) api_->proxy_marshal_flags(source, 1, nullptr, 1, kMarshalDestroy);
  }

  void Cleanup() {
    if (display_ && own_selection_) ClearOwned();
    for (auto& [proxy, offer] : offers_) { if (proxy && api_) api_->proxy_marshal_flags(proxy, 1, nullptr, 1, kMarshalDestroy); }
    offers_.clear();
    if (device_ && api_) api_->proxy_marshal_flags(device_, 1, nullptr, 1, kMarshalDestroy);
    if (manager_ && api_) api_->proxy_marshal_flags(manager_, 2, nullptr, 1, kMarshalDestroy);
    if (seat_ && api_) api_->proxy_destroy(seat_);
    if (registry_ && api_) api_->proxy_destroy(registry_);
    if (display_ && api_) { (void)api_->display_flush(display_); api_->display_disconnect(display_); }
    display_ = nullptr; device_ = nullptr; manager_ = nullptr; seat_ = nullptr; registry_ = nullptr;
    {
      std::lock_guard<std::mutex> lock(connection_mutex_);
      if (shutdown_fd_ >= 0) close(shutdown_fd_);
      shutdown_fd_ = -1;
    }
    std::vector<std::thread> writers;
    { std::lock_guard<std::mutex> lock(send_mutex_); writers.swap(send_threads_); }
    for (auto& writer : writers) if (writer.joinable()) writer.join();
  }

  inline static void (*RegistryListener[])(void) = {reinterpret_cast<void (*)(void)>(RegistryGlobal), reinterpret_cast<void (*)(void)>(RegistryRemove)};
  inline static void (*CallbackListener[])(void) = {reinterpret_cast<void (*)(void)>(SyncDone)};
  inline static void (*OfferListener[])(void) = {reinterpret_cast<void (*)(void)>(OfferMime)};
  inline static void (*DeviceListener[])(void) = {reinterpret_cast<void (*)(void)>(DeviceDataOffer), reinterpret_cast<void (*)(void)>(DeviceSelection), reinterpret_cast<void (*)(void)>(DeviceFinished), reinterpret_cast<void (*)(void)>(DevicePrimarySelection)};
  inline static void (*SourceListener[])(void) = {reinterpret_cast<void (*)(void)>(SourceSend), reinterpret_cast<void (*)(void)>(SourceCancelled)};

  std::shared_ptr<std::atomic<bool>> stopping_;
  std::mutex connection_mutex_;
  std::mutex join_mutex_;
  int shutdown_fd_ = -1;
  std::thread worker_;
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::deque<std::shared_ptr<Command>> commands_;
  std::promise<void> joined_promise_;
  std::shared_future<void> joined_;
  bool stopped_ = false;
  bool available_ = false;
  std::string reason_ = "WaylandSessionUnavailable";
  std::unique_ptr<Api> api_;
  wl_display* display_ = nullptr;
  wl_proxy* registry_ = nullptr;
  wl_proxy* seat_ = nullptr;
  wl_proxy* manager_ = nullptr;
  wl_proxy* device_ = nullptr;
  wl_proxy* selection_offer_ = nullptr;
  wl_proxy* own_source_ = nullptr;
  uint32_t manager_name_ = 0, manager_version_ = 1, wlr_manager_name_ = 0, wlr_manager_version_ = 2;
  uint32_t seat_name_ = 0, seat_version_ = 1;
  Protocol protocol_ = Protocol::Ext;
  uint64_t generation_ = 0;
  bool own_selection_ = false;
  Mode own_mode_ = Mode::Copy;
  std::string own_token_;
  std::vector<std::string> own_paths_;
  std::map<std::string, std::string> own_path_identities_;
  std::map<wl_proxy*, std::unique_ptr<Offer>> offers_;
  std::map<wl_proxy*, Source> sources_;
  std::mutex send_mutex_;
  std::vector<std::thread> send_threads_;
};

Session::Session() : impl_(std::make_unique<Impl>()) {}
Session::~Session() = default;
Result Session::Invoke(const Request& request) { return impl_->Invoke(request); }
void Session::Shutdown() { if (impl_) impl_->Shutdown(); }
void Session::AwaitStopped() { if (impl_) impl_->AwaitStopped(); }
bool Session::Available() const { return impl_ && impl_->Available(); }
std::string Session::UnavailableReason() const { return impl_ ? impl_->UnavailableReason() : "WaylandSessionUnavailable"; }

bool Probe(std::string* reason) {
  if (!reason) return false;
  Api api;
  if (!api.Open()) { *reason = "WaylandClientLibraryUnavailable"; return false; }
  const char* socket = std::getenv("WAYLAND_SOCKET");
  if (socket && *socket) { *reason = "WaylandSocketSessionsUnsupported"; return false; }
  if (!std::getenv("WAYLAND_DISPLAY") || !*std::getenv("WAYLAND_DISPLAY")) { *reason = "WaylandSessionUnavailable"; return false; }
  *reason = "WaylandDataControlNotProbed";
  return true;
}

}  // namespace native_linux_wayland_clipboard

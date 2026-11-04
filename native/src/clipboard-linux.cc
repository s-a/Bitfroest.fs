#include "clipboard-linux.h"
#include "clipboard-linux-formats.h"

#include <xcb/xcb.h>
#include <xcb/xcbext.h>
#include <xcb/xfixes.h>

#include <dlfcn.h>
#include <poll.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <functional>
#include <future>
#include <mutex>
#include <sstream>
#include <sys/stat.h>
#include <thread>
#include <unordered_map>
#include <utility>

namespace native_linux_clipboard {
namespace {
constexpr size_t kMaximumSelectionBytes = 1024 * 1024;
constexpr size_t kIncrementalThreshold = 48 * 1024;
constexpr size_t kIncrementalChunkBytes = 32 * 1024;
constexpr auto kRequestTimeout = std::chrono::milliseconds(1800);
constexpr uint8_t kXFixesSelectionNotify = XCB_XFIXES_SELECTION_NOTIFY;

struct XcbApi {
  void* xcb = nullptr;
  void* fixes = nullptr;
  decltype(&xcb_connect) connect = nullptr;
  decltype(&xcb_connection_has_error) has_error = nullptr;
  decltype(&xcb_disconnect) disconnect = nullptr;
  decltype(&xcb_get_setup) get_setup = nullptr;
  decltype(&xcb_setup_roots_iterator) roots = nullptr;
  decltype(&xcb_screen_next) screen_next = nullptr;
  decltype(&xcb_generate_id) generate_id = nullptr;
  decltype(&xcb_create_window) create_window = nullptr;
  decltype(&xcb_change_window_attributes) change_attributes = nullptr;
  decltype(&xcb_destroy_window) destroy_window = nullptr;
  decltype(&xcb_flush) flush = nullptr;
  decltype(&xcb_get_file_descriptor) file_descriptor = nullptr;
  decltype(&xcb_poll_for_event) poll_event = nullptr;
  decltype(&xcb_intern_atom) intern_atom = nullptr;
  decltype(&xcb_intern_atom_reply) intern_atom_reply = nullptr;
  decltype(&xcb_get_selection_owner) get_owner = nullptr;
  decltype(&xcb_get_selection_owner_reply) get_owner_reply = nullptr;
  decltype(&xcb_set_selection_owner) set_owner = nullptr;
  decltype(&xcb_convert_selection) convert = nullptr;
  decltype(&xcb_get_property) get_property = nullptr;
  decltype(&xcb_get_property_reply) get_property_reply = nullptr;
  decltype(&xcb_get_property_value) property_value = nullptr;
  decltype(&xcb_get_property_value_length) property_length = nullptr;
  decltype(&xcb_change_property) change_property = nullptr;
  decltype(&xcb_delete_property) delete_property = nullptr;
  decltype(&xcb_send_event) send_event = nullptr;
  decltype(&xcb_get_extension_data) extension_data = nullptr;
  decltype(&xcb_poll_for_reply) poll_reply = nullptr;
  decltype(&xcb_discard_reply) discard_reply = nullptr;
  decltype(&xcb_xfixes_query_version) fixes_version = nullptr;
  decltype(&xcb_xfixes_query_version_reply) fixes_version_reply = nullptr;
  decltype(&xcb_xfixes_select_selection_input) fixes_select = nullptr;
  bool Load() {
    xcb = dlopen("libxcb.so.1", RTLD_NOW | RTLD_LOCAL);
    fixes = dlopen("libxcb-xfixes.so.0", RTLD_NOW | RTLD_LOCAL);
    if (!xcb || !fixes) return false;
#define LOAD_XCB(member, symbol) member = reinterpret_cast<decltype(member)>(dlsym(xcb, symbol)); if (!member) return false
    LOAD_XCB(connect, "xcb_connect"); LOAD_XCB(has_error, "xcb_connection_has_error");
    LOAD_XCB(disconnect, "xcb_disconnect"); LOAD_XCB(get_setup, "xcb_get_setup");
    LOAD_XCB(roots, "xcb_setup_roots_iterator"); LOAD_XCB(screen_next, "xcb_screen_next");
    LOAD_XCB(generate_id, "xcb_generate_id"); LOAD_XCB(create_window, "xcb_create_window");
    LOAD_XCB(change_attributes, "xcb_change_window_attributes");
    LOAD_XCB(destroy_window, "xcb_destroy_window"); LOAD_XCB(flush, "xcb_flush");
    LOAD_XCB(file_descriptor, "xcb_get_file_descriptor"); LOAD_XCB(poll_event, "xcb_poll_for_event");
    LOAD_XCB(intern_atom, "xcb_intern_atom"); LOAD_XCB(intern_atom_reply, "xcb_intern_atom_reply");
    LOAD_XCB(get_owner, "xcb_get_selection_owner"); LOAD_XCB(get_owner_reply, "xcb_get_selection_owner_reply");
    LOAD_XCB(set_owner, "xcb_set_selection_owner"); LOAD_XCB(convert, "xcb_convert_selection");
    LOAD_XCB(get_property, "xcb_get_property"); LOAD_XCB(get_property_reply, "xcb_get_property_reply");
    LOAD_XCB(property_value, "xcb_get_property_value"); LOAD_XCB(property_length, "xcb_get_property_value_length");
    LOAD_XCB(change_property, "xcb_change_property"); LOAD_XCB(delete_property, "xcb_delete_property");
    LOAD_XCB(send_event, "xcb_send_event");
    LOAD_XCB(extension_data, "xcb_get_extension_data");
    LOAD_XCB(poll_reply, "xcb_poll_for_reply"); LOAD_XCB(discard_reply, "xcb_discard_reply");
#undef LOAD_XCB
#define LOAD_FIXES(member, symbol) member = reinterpret_cast<decltype(member)>(dlsym(fixes, symbol)); if (!member) return false
    LOAD_FIXES(fixes_version, "xcb_xfixes_query_version");
    LOAD_FIXES(fixes_version_reply, "xcb_xfixes_query_version_reply");
    LOAD_FIXES(fixes_select, "xcb_xfixes_select_selection_input");
#undef LOAD_FIXES
    return true;
  }
  ~XcbApi() { if (fixes) dlclose(fixes); if (xcb) dlclose(xcb); }
};

struct Atoms {
  xcb_atom_t clipboard = XCB_ATOM_NONE, targets = XCB_ATOM_NONE, timestamp = XCB_ATOM_NONE;
  xcb_atom_t atom = XCB_ATOM_NONE, integer = XCB_ATOM_NONE, incr = XCB_ATOM_NONE;
  xcb_atom_t uri = XCB_ATOM_NONE, gnome = XCB_ATOM_NONE, property = XCB_ATOM_NONE, timestamp_probe = XCB_ATOM_NONE;
};
}

class Session::Impl {
 public:
  Impl() { worker_ = std::thread([this] { Run(); }); }
  ~Impl() { Shutdown(); AwaitStopped(); }

  Result Invoke(const Request& request) {
    auto job = std::make_shared<Job>();
    job->request = request;
    auto future = job->promise.get_future();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (stopping_) return Failure("SessionClosed", "The clipboard session is closed.");
      jobs_.push_back(job);
    }
    condition_.notify_one();
    return future.get();
  }
  void Shutdown() {
    { std::lock_guard<std::mutex> lock(mutex_); stopping_ = true; }
    condition_.notify_all();
  }
  void AwaitStopped() {
    std::lock_guard<std::mutex> lock(join_mutex_);
    if (worker_.joinable()) worker_.join();
  }
  bool Available() const { return available_.load(); }
  std::string UnavailableReason() const {
    std::lock_guard<std::mutex> lock(status_mutex_);
    return unavailable_reason_;
  }

 private:
  struct Job { Request request; std::promise<Result> promise; };
  struct OutgoingTransfer {
    bool active = false; xcb_window_t requestor = XCB_WINDOW_NONE; xcb_atom_t property = XCB_ATOM_NONE;
    xcb_atom_t target = XCB_ATOM_NONE; std::string payload; size_t offset = 0;
    std::chrono::steady_clock::time_point deadline{};
  };
  static Result Failure(std::string code, std::string message) {
    Result result; result.code = std::move(code); result.message = std::move(message); return result;
  }
  bool IsWayland() const {
    const char* value = std::getenv("WAYLAND_DISPLAY");
    return value && *value;
  }
  void SetUnavailable(const std::string& reason) {
    std::lock_guard<std::mutex> lock(status_mutex_);
    unavailable_reason_ = reason;
    available_.store(false);
  }
  xcb_atom_t Atom(const char* name) {
    auto cookie = api_.intern_atom(connection_, 0, static_cast<uint16_t>(std::strlen(name)), name);
    auto* reply = reinterpret_cast<xcb_intern_atom_reply_t*>(WaitReply(cookie));
    if (!reply) return XCB_ATOM_NONE;
    const auto value = reply->atom; std::free(reply); return value;
  }
  bool Initialize() {
    if (IsWayland()) { SetUnavailable("UnsupportedWayland"); return false; }
    const char* display = std::getenv("DISPLAY");
    if (!display || !*display) { SetUnavailable("X11DisplayUnavailable"); return false; }
    if (!api_.Load()) { SetUnavailable("UnsupportedX11Libraries"); return false; }
    int screen_index = 0;
    connection_ = api_.connect(nullptr, &screen_index);
    if (!connection_ || api_.has_error(connection_)) { SetUnavailable("X11ConnectionFailed"); return false; }
    auto* setup = api_.get_setup(connection_);
    auto iterator = api_.roots(setup);
    for (int index = 0; index < screen_index; ++index) api_.screen_next(&iterator);
    if (!iterator.data) { SetUnavailable("X11ScreenUnavailable"); return false; }
    const xcb_window_t root = iterator.data->root;
    window_ = api_.generate_id(connection_);
    api_.create_window(connection_, XCB_COPY_FROM_PARENT, window_, root, 0, 0, 1, 1, 0,
                       XCB_WINDOW_CLASS_INPUT_ONLY, XCB_COPY_FROM_PARENT, 0, nullptr);
    const uint32_t event_mask = XCB_EVENT_MASK_PROPERTY_CHANGE;
    api_.change_attributes(connection_, window_, XCB_CW_EVENT_MASK, &event_mask);
    atoms_.clipboard = Atom("CLIPBOARD"); atoms_.targets = Atom("TARGETS");
    atoms_.timestamp = Atom("TIMESTAMP"); atoms_.atom = Atom("ATOM");
    atoms_.integer = Atom("INTEGER"); atoms_.incr = Atom("INCR");
    atoms_.uri = Atom("text/uri-list"); atoms_.gnome = Atom("x-special/gnome-copied-files");
    atoms_.property = Atom("_BITFROEST_CLIPBOARD_DATA");
    atoms_.timestamp_probe = Atom("_BITFROEST_CLIPBOARD_TIMESTAMP");
    if (!atoms_.clipboard || !atoms_.targets || !atoms_.timestamp || !atoms_.atom ||
        !atoms_.integer || !atoms_.uri || !atoms_.gnome || !atoms_.property || !atoms_.timestamp_probe) {
      SetUnavailable("X11AtomUnavailable"); return false;
    }
    auto cookie = api_.fixes_version(connection_, 5, 0);
    auto* version = reinterpret_cast<xcb_xfixes_query_version_reply_t*>(WaitReply(cookie));
    if (!version) { SetUnavailable("UnsupportedXFixes"); return false; }
    std::free(version);
    auto* extension = reinterpret_cast<xcb_extension_t*>(dlsym(api_.fixes, "xcb_xfixes_id"));
    const auto* extension_info = extension ? api_.extension_data(connection_, extension) : nullptr;
    if (!extension_info || !extension_info->present) { SetUnavailable("UnsupportedXFixes"); return false; }
    fixes_event_base_ = extension_info->first_event;
    api_.fixes_select(connection_, window_, atoms_.clipboard,
        XCB_XFIXES_SELECTION_EVENT_MASK_SET_SELECTION_OWNER |
        XCB_XFIXES_SELECTION_EVENT_MASK_SELECTION_WINDOW_DESTROY |
        XCB_XFIXES_SELECTION_EVENT_MASK_SELECTION_CLIENT_CLOSE);
    api_.flush(connection_);
    available_.store(true);
    return true;
  }
  bool WaitEvent(uint8_t expected, xcb_generic_event_t** output) {
    const auto deadline = std::chrono::steady_clock::now() + kRequestTimeout;
    while (std::chrono::steady_clock::now() < deadline && !StopRequested()) {
      if (api_.has_error(connection_)) return false;
      while (auto* event = api_.poll_event(connection_)) {
        const uint8_t type = event->response_type & 0x7f;
        if (type == expected) { *output = event; return true; }
        HandleEvent(event);
        std::free(event);
      }
      pollfd fd{api_.file_descriptor(connection_), POLLIN, 0};
      const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now());
      if (::poll(&fd, 1, std::max(1, std::min(20, static_cast<int>(remaining.count())))) < 0) return false;
    }
    return false;
  }
  bool StopRequested() {
    std::lock_guard<std::mutex> lock(mutex_); return stopping_;
  }
  template <typename Cookie>
  xcb_generic_reply_t* WaitReply(Cookie cookie) {
    api_.flush(connection_);
    const auto deadline = std::chrono::steady_clock::now() + kRequestTimeout;
    for (;;) {
      void* reply = nullptr;
      xcb_generic_error_t* error = nullptr;
      if (api_.poll_reply(connection_, cookie.sequence, &reply, &error)) {
        if (error) std::free(error);
        return static_cast<xcb_generic_reply_t*>(reply);
      }
      if (error) { std::free(error); return nullptr; }
      if (StopRequested() || api_.has_error(connection_) || std::chrono::steady_clock::now() >= deadline) {
        api_.discard_reply(connection_, cookie.sequence);
        return nullptr;
      }
      pollfd fd{api_.file_descriptor(connection_), POLLIN, 0};
      if (::poll(&fd, 1, 20) < 0) { api_.discard_reply(connection_, cookie.sequence); return nullptr; }
    }
  }
  bool GetProperty(xcb_atom_t property, xcb_atom_t requested_type, std::string* data, xcb_atom_t* type = nullptr) {
    auto cookie = api_.get_property(connection_, 1, window_, property, requested_type, 0,
                                     static_cast<uint32_t>(kMaximumSelectionBytes / 4));
    auto* reply = reinterpret_cast<xcb_get_property_reply_t*>(WaitReply(cookie));
    if (!reply) return false;
    const int length = api_.property_length(reply);
    bool valid = length >= 0 && static_cast<size_t>(length) <= kMaximumSelectionBytes && reply->bytes_after == 0;
    if (valid) {
      data->assign(static_cast<const char*>(api_.property_value(reply)), static_cast<size_t>(length));
      if (type) *type = reply->type;
    }
    std::free(reply);
    return valid;
  }
  bool Convert(xcb_atom_t target, std::string* data, xcb_atom_t* actual_type = nullptr) {
    api_.delete_property(connection_, window_, atoms_.property);
    api_.convert(connection_, window_, atoms_.clipboard, target, atoms_.property, XCB_CURRENT_TIME);
    api_.flush(connection_);
    xcb_generic_event_t* event = nullptr;
    if (!WaitEvent(XCB_SELECTION_NOTIFY, &event)) return false;
    auto* notify = reinterpret_cast<xcb_selection_notify_event_t*>(event);
    xcb_atom_t property_type = XCB_ATOM_NONE;
    bool success = notify->property != XCB_ATOM_NONE && GetProperty(atoms_.property, XCB_GET_PROPERTY_TYPE_ANY, data, &property_type);
    std::free(event);
    if (success && property_type == atoms_.incr) {
      data->clear();
      for (;;) {
        xcb_generic_event_t* property_event = nullptr;
        if (!WaitProperty(XCB_PROPERTY_NEW_VALUE, &property_event)) return false;
        auto* changed = reinterpret_cast<xcb_property_notify_event_t*>(property_event);
        const bool match = changed->window == window_ && changed->atom == atoms_.property;
        std::free(property_event);
        if (!match) continue;
        std::string chunk; xcb_atom_t chunk_type = XCB_ATOM_NONE;
        if (!GetProperty(atoms_.property, XCB_GET_PROPERTY_TYPE_ANY, &chunk, &chunk_type) ||
            (chunk_type != target && !chunk.empty()) || data->size() + chunk.size() > kMaximumSelectionBytes) return false;
        if (chunk.empty()) break;
        data->append(chunk);
      }
      property_type = target;
    }
    if (actual_type) *actual_type = property_type;
    return success;
  }
  bool WaitProperty(uint8_t state, xcb_generic_event_t** output) {
    const auto deadline = std::chrono::steady_clock::now() + kRequestTimeout;
    while (std::chrono::steady_clock::now() < deadline && !StopRequested()) {
      if (api_.has_error(connection_)) return false;
      while (auto* event = api_.poll_event(connection_)) {
        const uint8_t type = event->response_type & 0x7f;
        if (type == XCB_PROPERTY_NOTIFY && reinterpret_cast<xcb_property_notify_event_t*>(event)->state == state) {
          *output = event; return true;
        }
        HandleEvent(event); std::free(event);
      }
      pollfd fd{api_.file_descriptor(connection_), POLLIN, 0};
      if (::poll(&fd, 1, 20) < 0) return false;
    }
    return false;
  }
  uint32_t ServerTimestamp() {
    const uint8_t value = 0;
    api_.delete_property(connection_, window_, atoms_.timestamp_probe);
    api_.change_property(connection_, XCB_PROP_MODE_REPLACE, window_, atoms_.timestamp_probe,
                         atoms_.integer, 8, 1, &value);
    api_.flush(connection_);
    const auto deadline = std::chrono::steady_clock::now() + kRequestTimeout;
    while (std::chrono::steady_clock::now() < deadline && !StopRequested()) {
      xcb_generic_event_t* event = nullptr;
      if (WaitProperty(XCB_PROPERTY_NEW_VALUE, &event)) {
        auto* changed = reinterpret_cast<xcb_property_notify_event_t*>(event);
        const bool match = changed->window == window_ && changed->atom == atoms_.timestamp_probe;
        const uint32_t timestamp = changed->time;
        std::free(event);
        if (match) return timestamp;
      }
      else return XCB_CURRENT_TIME;
    }
    return XCB_CURRENT_TIME;
  }
  std::string MakeToken(xcb_window_t owner, const std::string& payload, const std::vector<std::string>& paths) {
    std::string identity;
    for (const auto& path : paths) {
      identity += path;
      identity.push_back('\0');
      identity += PathIdentity(path);
      identity.push_back('\n');
    }
    std::ostringstream output;
    output << std::hex << owner << '-' << owner_generation_ << '-'
           << std::hash<std::string>{}(payload) << '-' << std::hash<std::string>{}(identity);
    return output.str();
  }
  std::string PathIdentity(const std::string& path) const {
    struct stat value{};
    if (lstat(path.c_str(), &value) != 0) return "missing:" + std::to_string(errno);
    return std::to_string(static_cast<uint64_t>(value.st_dev)) + ":" +
        std::to_string(static_cast<uint64_t>(value.st_ino)) + ":" +
        std::to_string(static_cast<uint64_t>(value.st_mode & S_IFMT)) + ":" +
        std::to_string(static_cast<int64_t>(value.st_ctim.tv_sec)) + ":" +
        std::to_string(static_cast<int64_t>(value.st_ctim.tv_nsec));
  }
  void CaptureOwnIdentities() {
    own_path_identities_.clear();
    for (const auto& path : own_paths_) own_path_identities_.emplace(path, PathIdentity(path));
  }
  bool RemainingIdentitiesMatch(const std::vector<std::string>& remaining) const {
    for (const auto& path : remaining) {
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
  Result Read() {
    Result result; result.ok = true; result.available = true;
    auto cookie = api_.get_owner(connection_, atoms_.clipboard);
    auto* owner = reinterpret_cast<xcb_get_selection_owner_reply_t*>(WaitReply(cookie));
    if (!owner) return Failure("X11ConnectionLost", "The X11 clipboard connection was lost.");
    const xcb_window_t owner_window = owner->owner; std::free(owner);
    if (owner_window == XCB_WINDOW_NONE) return result;
    if (owner_window == window_ && !own_paths_.empty()) {
      if (OwnPathIdentityChanged()) {
        CaptureOwnIdentities();
        ++owner_generation_;
        own_token_ = MakeToken(window_, own_payload_, own_paths_);
      }
      result.paths = own_paths_; result.mode = own_mode_;
      result.token = own_token_; return result;
    }
    std::string targets_data;
    xcb_atom_t targets_type = XCB_ATOM_NONE;
    if (!Convert(atoms_.targets, &targets_data, &targets_type) || targets_type != atoms_.atom || targets_data.size() % sizeof(xcb_atom_t))
      return Failure("ClipboardRequestFailed", "The current clipboard owner did not provide its target list.");
    std::vector<xcb_atom_t> targets(targets_data.size() / sizeof(xcb_atom_t));
    std::memcpy(targets.data(), targets_data.data(), targets_data.size());
    const auto supports = [&](xcb_atom_t atom) { return std::find(targets.begin(), targets.end(), atom) != targets.end(); };
    std::string payload;
    FileSelection selection;
    bool parsed = false;
    if (supports(atoms_.gnome) && Convert(atoms_.gnome, &payload)) parsed = ParseGnomeCopiedFiles(payload, &selection);
    if (!parsed && supports(atoms_.uri) && Convert(atoms_.uri, &payload)) {
      parsed = ParseUriList(payload, &selection.paths); selection.mode = FileMode::Copy;
    }
    if (!parsed) return result;
    result.paths = std::move(selection.paths);
    result.mode = selection.mode == FileMode::Move ? Mode::Move : Mode::Copy;
    result.token = MakeToken(owner_window, payload, result.paths);
    seen_owner_ = owner_window; seen_payload_ = payload; seen_token_ = result.token;
    return result;
  }
  void Respond(const xcb_selection_request_event_t& request) {
    xcb_atom_t property = request.property ? request.property : request.target;
    if (request.target == atoms_.targets) {
      const std::array<xcb_atom_t, 4> values{atoms_.targets, atoms_.timestamp, atoms_.uri, atoms_.gnome};
      api_.change_property(connection_, XCB_PROP_MODE_REPLACE, request.requestor, property, atoms_.atom, 32,
                           static_cast<uint32_t>(values.size()), values.data());
    } else if (request.target == atoms_.timestamp) {
      const uint32_t timestamp = own_timestamp_;
      api_.change_property(connection_, XCB_PROP_MODE_REPLACE, request.requestor, property, atoms_.integer, 32, 1, &timestamp);
    } else if (request.target == atoms_.uri || request.target == atoms_.gnome) {
      const std::string& payload = request.target == atoms_.uri ? own_uri_ : own_payload_;
      if (payload.size() > kIncrementalThreshold) {
        if (outgoing_.active) property = XCB_ATOM_NONE;
        else {
          const uint32_t length = static_cast<uint32_t>(payload.size());
          const uint32_t event_mask = XCB_EVENT_MASK_PROPERTY_CHANGE;
          api_.change_attributes(connection_, request.requestor, XCB_CW_EVENT_MASK, &event_mask);
          api_.change_property(connection_, XCB_PROP_MODE_REPLACE, request.requestor, property, atoms_.incr, 32, 1, &length);
          outgoing_ = {true, request.requestor, property, request.target, payload, 0,
                       std::chrono::steady_clock::now() + kRequestTimeout};
        }
      } else {
        api_.change_property(connection_, XCB_PROP_MODE_REPLACE, request.requestor, property, request.target, 8,
                             static_cast<uint32_t>(payload.size()), payload.data());
      }
    } else property = XCB_ATOM_NONE;
    xcb_selection_notify_event_t notify{};
    notify.response_type = XCB_SELECTION_NOTIFY; notify.time = request.time; notify.requestor = request.requestor;
    notify.selection = request.selection; notify.target = request.target; notify.property = property;
    api_.send_event(connection_, 0, request.requestor, XCB_EVENT_MASK_NO_EVENT, reinterpret_cast<const char*>(&notify));
    api_.flush(connection_);
  }
  void HandleEvent(xcb_generic_event_t* event) {
    const uint8_t type = event->response_type & 0x7f;
    if (type == XCB_SELECTION_REQUEST) Respond(*reinterpret_cast<xcb_selection_request_event_t*>(event));
    if (type == XCB_PROPERTY_NOTIFY) {
      auto* changed = reinterpret_cast<xcb_property_notify_event_t*>(event);
      if (outgoing_.active && changed->window == outgoing_.requestor && changed->atom == outgoing_.property &&
          changed->state == XCB_PROPERTY_DELETE) {
        const size_t size = std::min(kIncrementalChunkBytes, outgoing_.payload.size() - outgoing_.offset);
        api_.change_property(connection_, XCB_PROP_MODE_REPLACE, outgoing_.requestor, outgoing_.property,
                             outgoing_.target, 8, static_cast<uint32_t>(size),
                             size ? outgoing_.payload.data() + outgoing_.offset : nullptr);
        outgoing_.offset += size;
        outgoing_.deadline = std::chrono::steady_clock::now() + kRequestTimeout;
        if (size == 0) outgoing_ = {};
        api_.flush(connection_);
      }
    }
    if (type == fixes_event_base_ + kXFixesSelectionNotify) {
      auto* notify = reinterpret_cast<xcb_xfixes_selection_notify_event_t*>(event);
      if (notify->selection == atoms_.clipboard && notify->owner != window_) {
        seen_owner_ = notify->owner; ++owner_generation_;
        own_paths_.clear(); own_payload_.clear(); own_uri_.clear();
      }
    }
  }
  Result Write(const Request& request) {
    FileSelection selection{request.paths, request.mode == Mode::Move ? FileMode::Move : FileMode::Copy};
    std::string gnome, uri;
    if (!EncodeGnomeCopiedFiles(selection, &gnome) || !EncodeUriList(request.paths, &uri))
      return Failure("InvalidSelection", "The file selection cannot be represented by the supported clipboard formats.");
    std::string combined = gnome;
    combined.push_back('\0'); combined += uri;
    own_timestamp_ = ServerTimestamp();
    if (own_timestamp_ == XCB_CURRENT_TIME) return Failure("X11RequestTimeout", "The X11 server did not provide a selection timestamp.");
    own_paths_ = request.paths; own_mode_ = request.mode; own_payload_ = std::move(gnome);
    own_uri_ = std::move(uri); ++owner_generation_;
    CaptureOwnIdentities();
    own_token_ = MakeToken(window_, own_payload_, own_paths_);
    api_.set_owner(connection_, window_, atoms_.clipboard, own_timestamp_); api_.flush(connection_);
    auto cookie = api_.get_owner(connection_, atoms_.clipboard);
    auto* owner = reinterpret_cast<xcb_get_selection_owner_reply_t*>(WaitReply(cookie));
    if (!owner || owner->owner != window_) { if (owner) std::free(owner); return Failure("ClipboardOwnerChanged", "The clipboard selection could not be retained."); }
    std::free(owner);
    Result result; result.ok = true; result.available = true; result.paths = request.paths; result.mode = request.mode;
    result.token = own_token_; seen_token_ = result.token;
    return result;
  }
  Result Apply(const Request& request) {
    if (!available_.load()) return Failure(unavailable_reason_, "The X11 file clipboard is unavailable.");
    if (request.operation == Operation::Read) return Read();
    if (request.operation == Operation::Write) return Write(request);
    Result result; result.ok = true; result.available = true;
    bool own = request.token == own_token_ && !own_paths_.empty() &&
        request.paths == own_paths_ && request.mode == own_mode_;
    if (own) {
      auto cookie = api_.get_owner(connection_, atoms_.clipboard);
      auto* owner = reinterpret_cast<xcb_get_selection_owner_reply_t*>(WaitReply(cookie));
      own = owner && owner->owner == window_;
      if (owner) std::free(owner);
    }
    const bool matched = own;
    result.matched = matched;
    if (request.operation == Operation::Cancel && matched && own) {
      auto cookie = api_.get_owner(connection_, atoms_.clipboard);
      auto* owner = reinterpret_cast<xcb_get_selection_owner_reply_t*>(WaitReply(cookie));
      if (owner && owner->owner == window_) api_.set_owner(connection_, XCB_WINDOW_NONE, atoms_.clipboard, XCB_CURRENT_TIME);
      if (owner) std::free(owner);
      own_paths_.clear(); own_payload_.clear(); own_uri_.clear(); api_.flush(connection_);
    } else if (request.operation == Operation::Acknowledge && matched && own && request.mode == Mode::Move) {
      auto cookie = api_.get_owner(connection_, atoms_.clipboard);
      auto* owner = reinterpret_cast<xcb_get_selection_owner_reply_t*>(WaitReply(cookie));
      if (owner && owner->owner == window_ && request.token == own_token_ && RemainingIdentitiesMatch(request.remaining_paths)) {
        own_paths_ = request.remaining_paths;
        if (own_paths_.empty()) { api_.set_owner(connection_, XCB_WINDOW_NONE, atoms_.clipboard, XCB_CURRENT_TIME); own_payload_.clear(); own_uri_.clear(); }
        else {
          FileSelection updated{own_paths_, own_mode_ == Mode::Move ? FileMode::Move : FileMode::Copy};
          if (!EncodeGnomeCopiedFiles(updated, &own_payload_) || !EncodeUriList(own_paths_, &own_uri_)) {
            result.notification_errors.push_back("Remaining selection could not be encoded.");
          }
          ++owner_generation_;
          CaptureOwnIdentities();
          own_token_ = MakeToken(window_, own_payload_, own_paths_);
        }
      } else result.matched = false;
      if (owner) std::free(owner);
      api_.flush(connection_);
    }
    return result;
  }
  void Run() {
    bool ready = Initialize();
    while (true) {
      std::shared_ptr<Job> job;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        if (jobs_.empty() && !stopping_) condition_.wait_for(lock, std::chrono::milliseconds(12));
        if (!jobs_.empty()) { job = jobs_.front(); jobs_.pop_front(); }
        else if (stopping_) break;
      }
      if (job) {
        Result result = ready ? Apply(job->request) : Failure(UnavailableReason(), "The X11 clipboard is unavailable.");
        job->promise.set_value(std::move(result));
      }
      if (outgoing_.active && std::chrono::steady_clock::now() >= outgoing_.deadline) outgoing_ = {};
      if (ready && connection_ && !api_.has_error(connection_)) {
        while (auto* event = api_.poll_event(connection_)) { HandleEvent(event); std::free(event); }
      } else if (ready) { ready = false; SetUnavailable("X11ConnectionLost"); }
    }
    if (connection_) {
      if (window_) api_.destroy_window(connection_, window_);
      api_.flush(connection_); api_.disconnect(connection_); connection_ = nullptr;
    }
    for (;;) {
      std::shared_ptr<Job> pending;
      { std::lock_guard<std::mutex> lock(mutex_); if (jobs_.empty()) break; pending = jobs_.front(); jobs_.pop_front(); }
      pending->promise.set_value(Failure("SessionClosed", "The clipboard session is closed."));
    }
  }

  XcbApi api_;
  xcb_connection_t* connection_ = nullptr;
  xcb_window_t window_ = XCB_WINDOW_NONE;
  Atoms atoms_;
  std::thread worker_;
  mutable std::mutex mutex_, status_mutex_, join_mutex_;
  std::condition_variable condition_;
  std::deque<std::shared_ptr<Job>> jobs_;
  bool stopping_ = false;
  std::atomic<bool> available_{false};
  std::string unavailable_reason_ = "ClipboardNotInitialized";
  std::vector<std::string> own_paths_;
  Mode own_mode_ = Mode::Copy;
  std::string own_payload_, own_uri_, seen_payload_, seen_token_;
  std::string own_token_;
  std::unordered_map<std::string, std::string> own_path_identities_;
  xcb_window_t seen_owner_ = XCB_WINDOW_NONE;
  uint64_t owner_generation_ = 0;
  uint32_t own_timestamp_ = XCB_CURRENT_TIME;
  uint8_t fixes_event_base_ = 0;
  OutgoingTransfer outgoing_;
};

Session::Session() : impl_(std::make_unique<Impl>()) {}
Session::~Session() = default;
Result Session::Invoke(const Request& request) { return impl_->Invoke(request); }
void Session::Shutdown() { impl_->Shutdown(); }
void Session::AwaitStopped() { impl_->AwaitStopped(); }
bool Session::Available() const { return impl_->Available(); }
std::string Session::UnavailableReason() const { return impl_->UnavailableReason(); }

bool Probe(std::string* reason) {
  if (reason) reason->clear();
  const char* wayland = std::getenv("WAYLAND_DISPLAY");
  if (wayland && *wayland) { if (reason) *reason = "UnsupportedWayland"; return false; }
  void* xcb = dlopen("libxcb.so.1", RTLD_NOW | RTLD_LOCAL);
  void* fixes = dlopen("libxcb-xfixes.so.0", RTLD_NOW | RTLD_LOCAL);
  if (!xcb || !fixes || !dlsym(xcb, "xcb_connect") || !dlsym(fixes, "xcb_xfixes_query_version")) {
    if (xcb) dlclose(xcb);
    if (fixes) dlclose(fixes);
    if (reason) *reason = "UnsupportedX11Libraries";
    return false;
  }
  dlclose(xcb); dlclose(fixes);
  const char* display = std::getenv("DISPLAY");
  if (!display || !*display) { if (reason) *reason = "X11DisplayUnavailable"; return false; }
  return true;
}

}  // namespace native_linux_clipboard

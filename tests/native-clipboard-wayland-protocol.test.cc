#include "../native/src/clipboard-linux.h"
#include "../native/src/clipboard-wayland-linux.h"

#include <wayland-server-core.h>
#include <wayland-server-protocol.h>
#include <ext-data-control-v1-server-protocol.h>

#include <fcntl.h>
#include <poll.h>
#include <sys/stat.h>
#include <unistd.h>

#include <atomic>
#include <algorithm>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <future>
#include <deque>
#include <functional>
#include <mutex>
#include <new>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {
void Require(bool value) { if (!value) std::abort(); }

class EnvironmentValue {
 public:
  explicit EnvironmentValue(const char* name) : name_(name) {
    const char* current = std::getenv(name);
    if (current) { present_ = true; value_ = current; }
  }
  ~EnvironmentValue() {
    if (present_) setenv(name_.c_str(), value_.c_str(), 1);
    else unsetenv(name_.c_str());
  }
  void Set(const std::string& value) { Require(setenv(name_.c_str(), value.c_str(), 1) == 0); }
  void Clear() { Require(unsetenv(name_.c_str()) == 0); }
 private:
  std::string name_;
  std::string value_;
  bool present_ = false;
};

class PrivateWaylandServer {
 public:
  explicit PrivateWaylandServer(bool offer_data_control, std::string payload = {}, bool hold_receive = false,
                                bool empty_wayland_socket = false)
      : payload_(std::move(payload)), hold_receive_(hold_receive) {
    char pattern[] = "/tmp/wayland-protocol-test-XXXXXX";
    char* directory = mkdtemp(pattern);
    Require(directory != nullptr);
    runtime_directory_ = directory;
    Require(chmod(runtime_directory_.c_str(), 0700) == 0);
    runtime_.Set(runtime_directory_);
    socket_name_ = "wayland-test-" + std::to_string(static_cast<long long>(getpid()));
    display_name_.Set(socket_name_);
    socket_.Clear();
    if (empty_wayland_socket) socket_.Set("");

    display_ = wl_display_create();
    Require(display_ != nullptr);
    Require(wl_display_add_socket(display_, socket_name_.c_str()) == 0);
    seat_global_ = wl_global_create(display_, &wl_seat_interface, 1, this, BindSeat);
    Require(seat_global_ != nullptr);
    if (offer_data_control) {
      manager_global_ = wl_global_create(display_, &ext_data_control_manager_v1_interface, 1, this, BindManager);
      Require(manager_global_ != nullptr);
    }
    loop_ = wl_display_get_event_loop(display_);
    Require(loop_ != nullptr && pipe2(wake_pipe_, O_CLOEXEC | O_NONBLOCK) == 0);
    server_thread_ = std::thread([this] { Run(); });
  }

  ~PrivateWaylandServer() { Stop(); }
  PrivateWaylandServer(const PrivateWaylandServer&) = delete;
  PrivateWaylandServer& operator=(const PrivateWaylandServer&) = delete;

  void Stop() {
    if (!display_) return;
    stopping_.store(true);
    const char wake = 1;
    ssize_t written;
    do { written = write(wake_pipe_[1], &wake, sizeof(wake)); } while (written < 0 && errno == EINTR);
    Require(written == sizeof(wake));
    if (server_thread_.joinable()) server_thread_.join();
    if (transfer_thread_.joinable()) transfer_thread_.join();
    ReleaseHeldReceive();
    wl_display_destroy_clients(display_);
    wl_display_destroy(display_);
    display_ = nullptr;
    if (wake_pipe_[0] >= 0) close(wake_pipe_[0]);
    if (wake_pipe_[1] >= 0) close(wake_pipe_[1]);
    wake_pipe_[0] = wake_pipe_[1] = -1;
    std::error_code ignored;
    std::filesystem::remove_all(runtime_directory_, ignored);
  }

  unsigned ReceiveCount() const { return receive_count_.load(); }
  bool ReceivedExpectedMime() const { return expected_mime_.load(); }
  bool WaitForSourceData(std::string* payload) {
    std::unique_lock<std::mutex> lock(transfer_mutex_);
    if (!transfer_changed_.wait_for(lock, std::chrono::seconds(5), [&] { return transfer_done_; })) return false;
    if (payload) *payload = transferred_payload_;
    return transfer_ok_;
  }
  bool WaitForClear() {
    std::unique_lock<std::mutex> lock(selection_mutex_);
    return selection_changed_.wait_for(lock, std::chrono::seconds(5), [&] { return clear_count_ > 0; });
  }
  bool OfferedExpectedMimes() const { return offered_uri_list_.load() && offered_gnome_files_.load(); }
  bool WaitForHeldReceive() {
    std::unique_lock<std::mutex> lock(held_mutex_);
    return held_changed_.wait_for(lock, std::chrono::seconds(5), [&] { return held_fd_ >= 0; });
  }
  void ChangeSelectionToEmpty() {
    Post([this] {
      if (device_resource_) ext_data_control_device_v1_send_selection(device_resource_, nullptr);
      selection_change_sent_.store(true);
    });
  }
  bool WaitForSelectionChangeSent() const {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (!selection_change_sent_.load() && std::chrono::steady_clock::now() < deadline) usleep(1000);
    return selection_change_sent_.load();
  }
  void ReleaseHeldReceive() {
    std::lock_guard<std::mutex> lock(held_mutex_);
    if (held_fd_ < 0) return;
    size_t offset = 0;
    while (offset < payload_.size()) {
      const ssize_t count = write(held_fd_, payload_.data() + offset, payload_.size() - offset);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) break;
      offset += static_cast<size_t>(count);
    }
    close(held_fd_);
    held_fd_ = -1;
  }

 private:
  struct SourceState {
    PrivateWaylandServer* server = nullptr;
    wl_resource* resource = nullptr;
    std::vector<std::string> mime_types;
  };

  void Run() {
    const int event_fd = wl_event_loop_get_fd(loop_);
    while (!stopping_.load()) {
      if (wl_event_loop_dispatch(loop_, 0) < 0) break;
      wl_event_loop_dispatch_idle(loop_);
      (void)wl_display_flush_clients(display_);
      pollfd descriptors[2] = {{event_fd, POLLIN, 0}, {wake_pipe_[0], POLLIN, 0}};
      const int ready = poll(descriptors, 2, -1);
      if (ready < 0) { if (errno == EINTR) continue; break; }
      if (descriptors[1].revents & (POLLIN | POLLHUP | POLLERR)) {
        char bytes[128];
        while (read(wake_pipe_[0], bytes, sizeof(bytes)) > 0) {}
        if (stopping_.load()) break;
        std::deque<std::function<void()>> tasks;
        { std::lock_guard<std::mutex> lock(task_mutex_); tasks.swap(tasks_); }
        for (auto& task : tasks) task();
        continue;
      }
      if (descriptors[0].revents & (POLLHUP | POLLERR | POLLNVAL)) break;
    }
  }

  void Post(std::function<void()> task) {
    { std::lock_guard<std::mutex> lock(task_mutex_); tasks_.push_back(std::move(task)); }
    const char wake = 1;
    ssize_t written;
    do { written = write(wake_pipe_[1], &wake, sizeof(wake)); } while (written < 0 && errno == EINTR);
    Require(written == sizeof(wake));
  }

  void BeginSourceTransfer(SourceState* source) {
    const std::string mime = "x-special/gnome-copied-files";
    const bool offered = source && std::find(source->mime_types.begin(), source->mime_types.end(), mime) != source->mime_types.end();
    offered_gnome_files_.store(offered);
    offered_uri_list_.store(source && std::find(source->mime_types.begin(), source->mime_types.end(), "text/uri-list") != source->mime_types.end());
    if (!offered || transfer_thread_.joinable()) return;
    int descriptors[2];
    Require(pipe2(descriptors, O_CLOEXEC | O_NONBLOCK) == 0);
    transfer_thread_ = std::thread([this, fd = descriptors[0]] {
      std::string bytes;
      bool success = false;
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(4);
      char buffer[1024];
      while (std::chrono::steady_clock::now() < deadline) {
        pollfd descriptor{fd, POLLIN | POLLHUP, 0};
        const int ready = poll(&descriptor, 1, 100);
        if (ready < 0) { if (errno == EINTR) continue; break; }
        if (ready == 0) continue;
        const ssize_t count = read(fd, buffer, sizeof(buffer));
        if (count > 0) { bytes.append(buffer, static_cast<size_t>(count)); continue; }
        if (count == 0) { success = true; break; }
        if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) continue;
        break;
      }
      close(fd);
      {
        std::lock_guard<std::mutex> lock(transfer_mutex_);
        transferred_payload_ = std::move(bytes);
        transfer_ok_ = success;
        transfer_done_ = true;
      }
      transfer_changed_.notify_all();
    });
    ext_data_control_source_v1_send_send(source->resource, mime.c_str(), descriptors[1]);
    wl_display_flush_clients(display_);
    close(descriptors[1]);
  }

  static void BindSeat(wl_client* client, void* data, uint32_t version, uint32_t id) {
    auto* self = static_cast<PrivateWaylandServer*>(data);
    wl_resource* resource = wl_resource_create(client, &wl_seat_interface, std::min(version, 1u), id);
    if (!resource) { wl_client_post_no_memory(client); return; }
    static const struct wl_seat_interface implementation = {GetPointer, GetKeyboard, GetTouch, ReleaseSeat};
    wl_resource_set_implementation(resource, &implementation, self, nullptr);
    wl_seat_send_capabilities(resource, 0);
  }

  static void GetPointer(wl_client*, wl_resource*, uint32_t) {}
  static void GetKeyboard(wl_client*, wl_resource*, uint32_t) {}
  static void GetTouch(wl_client*, wl_resource*, uint32_t) {}
  static void ReleaseSeat(wl_client*, wl_resource* resource) { wl_resource_destroy(resource); }

  static void BindManager(wl_client* client, void* data, uint32_t version, uint32_t id) {
    auto* self = static_cast<PrivateWaylandServer*>(data);
    wl_resource* resource = wl_resource_create(client, &ext_data_control_manager_v1_interface, std::min(version, 1u), id);
    if (!resource) { wl_client_post_no_memory(client); return; }
    static const struct ext_data_control_manager_v1_interface implementation = {CreateSource, GetDataDevice, DestroyManager};
    wl_resource_set_implementation(resource, &implementation, self, nullptr);
  }

  static void CreateSource(wl_client* client, wl_resource* manager, uint32_t id) {
    auto* self = static_cast<PrivateWaylandServer*>(wl_resource_get_user_data(manager));
    wl_resource* resource = wl_resource_create(client, &ext_data_control_source_v1_interface, 1, id);
    if (!resource) { wl_client_post_no_memory(client); return; }
    auto* source = new (std::nothrow) SourceState{self, resource, {}};
    if (!source) { wl_resource_destroy(resource); wl_client_post_no_memory(client); return; }
    static const struct ext_data_control_source_v1_interface implementation = {OfferSource, DestroySource};
    wl_resource_set_implementation(resource, &implementation, source, DestroySourceResource);
  }
  static void GetDataDevice(wl_client* client, wl_resource* manager, uint32_t id, wl_resource* seat) {
    auto* self = static_cast<PrivateWaylandServer*>(wl_resource_get_user_data(manager));
    Require(seat != nullptr && self != nullptr);
    wl_resource* device = wl_resource_create(client, &ext_data_control_device_v1_interface, 1, id);
    if (!device) { wl_client_post_no_memory(client); return; }
    static const struct ext_data_control_device_v1_interface implementation = {SetSelection, DestroyDevice, SetPrimarySelection};
    wl_resource_set_implementation(device, &implementation, self, nullptr);
    self->device_resource_ = device;

    wl_resource* offer = wl_resource_create(client, &ext_data_control_offer_v1_interface, 1, 0);
    if (!offer) { wl_client_post_no_memory(client); return; }
    static const struct ext_data_control_offer_v1_interface offer_implementation = {Receive, DestroyOffer};
    wl_resource_set_implementation(offer, &offer_implementation, self, nullptr);
    ext_data_control_device_v1_send_data_offer(device, offer);
    ext_data_control_offer_v1_send_offer(offer, "x-special/gnome-copied-files");
    ext_data_control_device_v1_send_selection(device, offer);
  }

  static void DestroyManager(wl_client*, wl_resource* resource) { wl_resource_destroy(resource); }
  static void SetSelection(wl_client*, wl_resource* device, wl_resource* source_resource) {
    auto* self = static_cast<PrivateWaylandServer*>(wl_resource_get_user_data(device));
    if (!self) return;
    if (!source_resource) {
      {
        std::lock_guard<std::mutex> lock(self->selection_mutex_);
        ++self->clear_count_;
      }
      self->selection_changed_.notify_all();
      return;
    }
    auto* source = static_cast<SourceState*>(wl_resource_get_user_data(source_resource));
    self->BeginSourceTransfer(source);
  }
  static void DestroyDevice(wl_client*, wl_resource* resource) { wl_resource_destroy(resource); }
  static void SetPrimarySelection(wl_client*, wl_resource*, wl_resource*) {}
  static void DestroyOffer(wl_client*, wl_resource* resource) { wl_resource_destroy(resource); }

  static void OfferSource(wl_client*, wl_resource* resource, const char* mime_type) {
    auto* source = static_cast<SourceState*>(wl_resource_get_user_data(resource));
    if (!source || !mime_type) return;
    source->mime_types.emplace_back(mime_type);
  }

  static void DestroySource(wl_client*, wl_resource* resource) { wl_resource_destroy(resource); }
  static void DestroySourceResource(wl_resource* resource) {
    delete static_cast<SourceState*>(wl_resource_get_user_data(resource));
  }

  static void Receive(wl_client*, wl_resource* resource, const char* mime_type, int fd) {
    auto* self = static_cast<PrivateWaylandServer*>(wl_resource_get_user_data(resource));
    if (!self || !mime_type || fd < 0) { if (fd >= 0) close(fd); return; }
    ++self->receive_count_;
    if (std::strcmp(mime_type, "x-special/gnome-copied-files") == 0) self->expected_mime_.store(true);
    if (self->hold_receive_) {
      { std::lock_guard<std::mutex> lock(self->held_mutex_); self->held_fd_ = fd; }
      self->held_changed_.notify_all();
      return;
    }
    size_t offset = 0;
    while (offset < self->payload_.size()) {
      const ssize_t written = write(fd, self->payload_.data() + offset, self->payload_.size() - offset);
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) break;
      offset += static_cast<size_t>(written);
    }
    close(fd);
  }

  std::string payload_;
  bool hold_receive_ = false;
  std::string runtime_directory_;
  std::string socket_name_;
  EnvironmentValue runtime_{"XDG_RUNTIME_DIR"};
  EnvironmentValue display_name_{"WAYLAND_DISPLAY"};
  EnvironmentValue socket_{"WAYLAND_SOCKET"};
  wl_display* display_ = nullptr;
  wl_global* seat_global_ = nullptr;
  wl_global* manager_global_ = nullptr;
  std::thread server_thread_;
  std::atomic<unsigned> receive_count_{0};
  std::atomic<bool> expected_mime_{false};
  std::atomic<bool> offered_uri_list_{false};
  std::atomic<bool> offered_gnome_files_{false};
  std::atomic<bool> stopping_{false};
  std::mutex transfer_mutex_;
  std::condition_variable transfer_changed_;
  std::string transferred_payload_;
  bool transfer_done_ = false;
  bool transfer_ok_ = false;
  std::mutex selection_mutex_;
  std::condition_variable selection_changed_;
  unsigned clear_count_ = 0;
  wl_event_loop* loop_ = nullptr;
  int wake_pipe_[2] = {-1, -1};
  std::thread transfer_thread_;
  wl_resource* device_resource_ = nullptr;
  std::mutex task_mutex_;
  std::deque<std::function<void()>> tasks_;
  std::atomic<bool> selection_change_sent_{false};
  std::mutex held_mutex_;
  std::condition_variable held_changed_;
  int held_fd_ = -1;
};

void MissingGlobalIsReportedAsUnsupported() {
  PrivateWaylandServer server(false);
  native_linux_wayland_clipboard::Session session;
  native_linux_clipboard::Request request;
  request.operation = native_linux_clipboard::Operation::Read;
  auto pending = std::async(std::launch::async, [&] { return session.Invoke(request); });
  if (pending.wait_for(std::chrono::seconds(12)) != std::future_status::ready) {
    session.Shutdown();
    server.Stop();
    (void)pending.get();
    Require(false);
  }
  const auto result = pending.get();
  Require(!result.ok && !result.available);
  Require(result.code == "UnsupportedOperation");
  Require(result.message == "WaylandDataControlUnavailable");
  session.Shutdown();
  session.AwaitStopped();
  server.Stop();
}

void GnomeFileSelectionIsReadThroughTheProtocol() {
  const std::string payload = "cut\nfile:///tmp/Gr%C3%BC%C3%9Fe%20%23.txt\r\nfile:///var/tmp/%E9%9B%AA%E9%9B%A8.bin\r\n";
  PrivateWaylandServer server(true, payload);
  native_linux_wayland_clipboard::Session session;
  native_linux_clipboard::Request request;
  request.operation = native_linux_clipboard::Operation::Read;
  auto pending = std::async(std::launch::async, [&] { return session.Invoke(request); });
  if (pending.wait_for(std::chrono::seconds(12)) != std::future_status::ready) {
    session.Shutdown();
    server.Stop();
    (void)pending.get();
    Require(false);
  }
  const auto result = pending.get();
  Require(result.ok && result.available);
  Require(result.mode == native_linux_clipboard::Mode::Move);
  Require(result.paths == std::vector<std::string>({"/tmp/Grüße #.txt", "/var/tmp/雪雨.bin"}));
  Require(!result.token.empty());
  Require(server.ReceiveCount() == 1 && server.ReceivedExpectedMime());
  session.Shutdown();
  session.AwaitStopped();
  server.Stop();
}

void FileSelectionWriteTransfersCanonicalPayloadAndCancelClearsTheSelection() {
  PrivateWaylandServer server(true);
  native_linux_wayland_clipboard::Session session;
  native_linux_clipboard::Request request;
  request.operation = native_linux_clipboard::Operation::Write;
  request.paths = {"/tmp/clipboard write ü #.txt", "/var/tmp/第二.txt"};
  request.mode = native_linux_clipboard::Mode::Move;
  auto pending = std::async(std::launch::async, [&] { return session.Invoke(request); });
  if (pending.wait_for(std::chrono::seconds(12)) != std::future_status::ready) {
    session.Shutdown();
    server.Stop();
    (void)pending.get();
    Require(false);
  }
  const auto result = pending.get();
  Require(result.ok && result.available && result.mode == request.mode && result.paths == request.paths);
  Require(!result.token.empty());
  std::string transferred;
  Require(server.WaitForSourceData(&transferred));
  Require(server.OfferedExpectedMimes());
  Require(transferred == "cut\nfile:///tmp/clipboard%20write%20%C3%BC%20%23.txt\r\nfile:///var/tmp/%E7%AC%AC%E4%BA%8C.txt\r\n");

  native_linux_clipboard::Request cancel;
  cancel.operation = native_linux_clipboard::Operation::Cancel;
  cancel.paths = request.paths;
  cancel.mode = request.mode;
  cancel.token = result.token;
  auto cancellation = std::async(std::launch::async, [&] { return session.Invoke(cancel); });
  if (cancellation.wait_for(std::chrono::seconds(12)) != std::future_status::ready) {
    session.Shutdown();
    server.Stop();
    (void)cancellation.get();
    Require(false);
  }
  const auto cleared = cancellation.get();
  Require(cleared.ok && cleared.available && cleared.matched);
  Require(server.WaitForClear());
  session.Shutdown();
  session.AwaitStopped();
  server.Stop();
}

void ReadRejectsAnOfferChangedDuringTheDataTransfer() {
  const std::string payload = "copy\nfile:///tmp/changed-during-transfer.txt\r\n";
  PrivateWaylandServer server(true, payload, true);
  native_linux_wayland_clipboard::Session session;
  native_linux_clipboard::Request request;
  request.operation = native_linux_clipboard::Operation::Read;
  auto pending = std::async(std::launch::async, [&] { return session.Invoke(request); });
  Require(server.WaitForHeldReceive());
  server.ChangeSelectionToEmpty();
  Require(server.WaitForSelectionChangeSent());
  server.ReleaseHeldReceive();
  if (pending.wait_for(std::chrono::seconds(12)) != std::future_status::ready) {
    session.Shutdown(); server.Stop(); (void)pending.get(); Require(false);
  }
  const auto result = pending.get();
  Require(!result.ok && result.code == "ClipboardChanged");
  session.Shutdown(); session.AwaitStopped(); server.Stop();
}

void WaylandTokenChangesWhenAPathIsRecreatedUnderTheSameOffer() {
  char pattern[] = "/tmp/wayland-token-identity-XXXXXX";
  char* directory = mkdtemp(pattern);
  Require(directory != nullptr);
  const std::filesystem::path file = std::filesystem::path(directory) / "selected.txt";
  const std::filesystem::path old_file = std::filesystem::path(directory) / "old.txt";
  { std::ofstream output(file); output << "before"; }
  const std::string payload = "copy\nfile://" + file.string() + "\r\n";
  PrivateWaylandServer server(true, payload);
  native_linux_wayland_clipboard::Session session;
  native_linux_clipboard::Request request;
  request.operation = native_linux_clipboard::Operation::Read;
  const auto first = session.Invoke(request);
  Require(first.ok && first.paths == std::vector<std::string>{file.string()});
  std::filesystem::rename(file, old_file);
  { std::ofstream output(file); output << "after"; }
  const auto second = session.Invoke(request);
  Require(second.ok && second.paths == first.paths && second.token != first.token);
  session.Shutdown(); session.AwaitStopped(); server.Stop();
  std::error_code ignored; std::filesystem::remove_all(directory, ignored);
}

void EmptyWaylandSocketDoesNotOverrideNamedDisplay() {
  const std::string payload = "copy\nfile:///tmp/empty-socket.txt\r\n";
  PrivateWaylandServer server(true, payload, false, true);
  native_linux_wayland_clipboard::Session session;
  native_linux_clipboard::Request request;
  request.operation = native_linux_clipboard::Operation::Read;
  const auto result = session.Invoke(request);
  Require(result.ok && result.paths == std::vector<std::string>{"/tmp/empty-socket.txt"});
  session.Shutdown(); session.AwaitStopped(); server.Stop();
}

void OwnedTokenChangesWhenItsPathIdentityChanges() {
  char pattern[] = "/tmp/wayland-owned-identity-XXXXXX";
  char* directory = mkdtemp(pattern);
  Require(directory != nullptr);
  const std::filesystem::path file = std::filesystem::path(directory) / "selected.txt";
  const std::filesystem::path old_file = std::filesystem::path(directory) / "old.txt";
  { std::ofstream output(file); output << "before"; }
  PrivateWaylandServer server(true);
  native_linux_wayland_clipboard::Session session;
  native_linux_clipboard::Request write;
  write.operation = native_linux_clipboard::Operation::Write;
  write.paths = {file.string()}; write.mode = native_linux_clipboard::Mode::Move;
  const auto original = session.Invoke(write);
  Require(original.ok && !original.token.empty());
  std::filesystem::rename(file, old_file);
  { std::ofstream output(file); output << "after"; }
  native_linux_clipboard::Request read;
  read.operation = native_linux_clipboard::Operation::Read;
  const auto changed = session.Invoke(read);
  Require(changed.ok && changed.token != original.token);
  session.Shutdown(); session.AwaitStopped(); server.Stop();
  std::error_code ignored; std::filesystem::remove_all(directory, ignored);
}

void PartialMoveDoesNotRetainAReplacedRemainingPath() {
  char pattern[] = "/tmp/wayland-remaining-identity-XXXXXX";
  char* directory = mkdtemp(pattern);
  Require(directory != nullptr);
  const std::filesystem::path first_path = std::filesystem::path(directory) / "first.txt";
  const std::filesystem::path remaining_path = std::filesystem::path(directory) / "remaining.txt";
  const std::filesystem::path old_path = std::filesystem::path(directory) / "old.txt";
  { std::ofstream output(first_path); output << "first"; }
  { std::ofstream output(remaining_path); output << "before"; }
  PrivateWaylandServer server(true);
  native_linux_wayland_clipboard::Session session;
  native_linux_clipboard::Request write;
  write.operation = native_linux_clipboard::Operation::Write;
  write.paths = {first_path.string(), remaining_path.string()}; write.mode = native_linux_clipboard::Mode::Move;
  const auto original = session.Invoke(write);
  Require(original.ok);
  std::filesystem::rename(remaining_path, old_path);
  { std::ofstream output(remaining_path); output << "replacement"; }
  native_linux_clipboard::Request acknowledge;
  acknowledge.operation = native_linux_clipboard::Operation::Acknowledge;
  acknowledge.paths = write.paths; acknowledge.remaining_paths = {remaining_path.string()};
  acknowledge.mode = write.mode; acknowledge.token = original.token;
  const auto result = session.Invoke(acknowledge);
  Require(result.ok && !result.matched);
  const auto current = session.Invoke(native_linux_clipboard::Request{});
  Require(current.ok && current.paths == write.paths);
  session.Shutdown(); session.AwaitStopped(); server.Stop();
  std::error_code ignored; std::filesystem::remove_all(directory, ignored);
}
}

int main(int argc, char** argv) {
  if (argc > 1 && std::strcmp(argv[1], "read-owner-race") == 0) { ReadRejectsAnOfferChangedDuringTheDataTransfer(); return 0; }
  if (argc > 1 && std::strcmp(argv[1], "path-identity") == 0) { WaylandTokenChangesWhenAPathIsRecreatedUnderTheSameOffer(); return 0; }
  if (argc > 1 && std::strcmp(argv[1], "empty-socket") == 0) { EmptyWaylandSocketDoesNotOverrideNamedDisplay(); return 0; }
  if (argc > 1 && std::strcmp(argv[1], "owned-identity") == 0) { OwnedTokenChangesWhenItsPathIdentityChanges(); return 0; }
  if (argc > 1 && std::strcmp(argv[1], "remaining-identity") == 0) { PartialMoveDoesNotRetainAReplacedRemainingPath(); return 0; }
  MissingGlobalIsReportedAsUnsupported();
  GnomeFileSelectionIsReadThroughTheProtocol();
  FileSelectionWriteTransfersCanonicalPayloadAndCancelClearsTheSelection();
  ReadRejectsAnOfferChangedDuringTheDataTransfer();
  WaylandTokenChangesWhenAPathIsRecreatedUnderTheSameOffer();
  EmptyWaylandSocketDoesNotOverrideNamedDisplay();
  OwnedTokenChangesWhenItsPathIdentityChanges();
  PartialMoveDoesNotRetainAReplacedRemainingPath();
  return 0;
}

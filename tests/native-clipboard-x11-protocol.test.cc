#include <xcb/xcb.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <poll.h>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

namespace {
struct Atoms {
  xcb_atom_t clipboard = XCB_ATOM_NONE;
  xcb_atom_t targets = XCB_ATOM_NONE;
  xcb_atom_t atom = XCB_ATOM_NONE;
  xcb_atom_t incr = XCB_ATOM_NONE;
  xcb_atom_t gnome = XCB_ATOM_NONE;
  xcb_atom_t property_one = XCB_ATOM_NONE;
  xcb_atom_t property_two = XCB_ATOM_NONE;
};

xcb_atom_t Intern(xcb_connection_t* connection, const char* name) {
  auto cookie = xcb_intern_atom(connection, 0, static_cast<uint16_t>(std::strlen(name)), name);
  auto* reply = xcb_intern_atom_reply(connection, cookie, nullptr);
  if (!reply) return XCB_ATOM_NONE;
  const xcb_atom_t atom = reply->atom;
  std::free(reply);
  return atom;
}

bool LoadAtoms(xcb_connection_t* connection, Atoms* atoms) {
  atoms->clipboard = Intern(connection, "CLIPBOARD");
  atoms->targets = Intern(connection, "TARGETS");
  atoms->atom = Intern(connection, "ATOM");
  atoms->incr = Intern(connection, "INCR");
  atoms->gnome = Intern(connection, "x-special/gnome-copied-files");
  atoms->property_one = Intern(connection, "_X11_PROTOCOL_TEST_ONE");
  atoms->property_two = Intern(connection, "_X11_PROTOCOL_TEST_TWO");
  return atoms->clipboard && atoms->targets && atoms->atom && atoms->incr && atoms->gnome &&
      atoms->property_one && atoms->property_two;
}

bool WaitOwner(xcb_connection_t* connection, xcb_atom_t selection, xcb_window_t expected) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (std::chrono::steady_clock::now() < deadline) {
    auto cookie = xcb_get_selection_owner(connection, selection);
    auto* reply = xcb_get_selection_owner_reply(connection, cookie, nullptr);
    if (!reply) return false;
    const bool matches = reply->owner == expected;
    std::free(reply);
    if (matches) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  return false;
}

bool CreateWindow(xcb_connection_t* connection, xcb_window_t root, xcb_window_t* window) {
  *window = xcb_generate_id(connection);
  const uint32_t mask = XCB_EVENT_MASK_PROPERTY_CHANGE;
  xcb_create_window(connection, XCB_COPY_FROM_PARENT, *window, root, 0, 0, 1, 1, 0,
                    XCB_WINDOW_CLASS_INPUT_ONLY, XCB_COPY_FROM_PARENT, XCB_CW_EVENT_MASK, &mask);
  xcb_flush(connection);
  return *window != XCB_WINDOW_NONE;
}

void Notify(xcb_connection_t* connection, const xcb_selection_request_event_t& request, xcb_atom_t property) {
  xcb_selection_notify_event_t event{};
  event.response_type = XCB_SELECTION_NOTIFY;
  event.time = request.time;
  event.requestor = request.requestor;
  event.selection = request.selection;
  event.target = request.target;
  event.property = property;
  xcb_send_event(connection, 0, request.requestor, XCB_EVENT_MASK_NO_EVENT,
                 reinterpret_cast<const char*>(&event));
}

int ParallelRequestors() {
  int screen_index = 0;
  xcb_connection_t* connection = xcb_connect(nullptr, &screen_index);
  if (!connection || xcb_connection_has_error(connection)) return 2;
  Atoms atoms;
  if (!LoadAtoms(connection, &atoms)) { xcb_disconnect(connection); return 2; }
  xcb_window_t windows[2]{};
  auto* screen = xcb_setup_roots_iterator(xcb_get_setup(connection)).data;
  if (!screen || !CreateWindow(connection, screen->root, &windows[0]) ||
      !CreateWindow(connection, screen->root, &windows[1])) { xcb_disconnect(connection); return 2; }
  xcb_convert_selection(connection, windows[0], atoms.clipboard, atoms.gnome, atoms.property_one, XCB_CURRENT_TIME);
  xcb_convert_selection(connection, windows[1], atoms.clipboard, atoms.gnome, atoms.property_two, XCB_CURRENT_TIME);
  xcb_flush(connection);

  xcb_atom_t properties[2]{XCB_ATOM_NONE, XCB_ATOM_NONE};
  bool notified[2]{false, false};
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while ((!notified[0] || !notified[1]) && std::chrono::steady_clock::now() < deadline) {
    pollfd fd{xcb_get_file_descriptor(connection), POLLIN, 0};
    if (::poll(&fd, 1, 100) < 0 && errno != EINTR) break;
    while (auto* event = xcb_poll_for_event(connection)) {
      if ((event->response_type & 0x7f) == XCB_SELECTION_NOTIFY) {
        const auto* notify = reinterpret_cast<xcb_selection_notify_event_t*>(event);
        for (size_t index = 0; index < 2; ++index) {
          if (notify->requestor == windows[index]) {
            notified[index] = true;
            properties[index] = notify->property;
          }
        }
      }
      std::free(event);
    }
  }
  bool valid = notified[0] && notified[1] && properties[0] != XCB_ATOM_NONE && properties[1] != XCB_ATOM_NONE;
  struct PendingTransfer { xcb_window_t window; xcb_atom_t property; std::string data; bool complete = false; };
  std::array<PendingTransfer, 2> transfers{{{windows[0], properties[0], {}, false},
                                             {windows[1], properties[1], {}, false}}};
  for (size_t index = 0; index < 2 && valid; ++index) {
    auto cookie = xcb_get_property(connection, 1, windows[index], properties[index], XCB_GET_PROPERTY_TYPE_ANY, 0, 1);
    auto* reply = xcb_get_property_reply(connection, cookie, nullptr);
    valid = reply && reply->type == atoms.incr && xcb_get_property_value_length(reply) == 4;
    if (reply) std::free(reply);
  }

  const auto transfer_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (valid && (!transfers[0].complete || !transfers[1].complete) &&
         std::chrono::steady_clock::now() < transfer_deadline) {
    pollfd fd{xcb_get_file_descriptor(connection), POLLIN, 0};
    if (::poll(&fd, 1, 100) < 0 && errno != EINTR) { valid = false; break; }
    while (auto* event = xcb_poll_for_event(connection)) {
      if ((event->response_type & 0x7f) == XCB_PROPERTY_NOTIFY) {
        const auto* property = reinterpret_cast<const xcb_property_notify_event_t*>(event);
        if (property->state == XCB_PROPERTY_NEW_VALUE) {
          for (auto& transfer : transfers) {
            if (property->window != transfer.window || property->atom != transfer.property || transfer.complete) continue;
            auto cookie = xcb_get_property(connection, 1, transfer.window, transfer.property, XCB_GET_PROPERTY_TYPE_ANY, 0,
                                           static_cast<uint32_t>(1024 * 1024 / 4));
            auto* reply = xcb_get_property_reply(connection, cookie, nullptr);
            if (!reply || (reply->type != atoms.gnome && xcb_get_property_value_length(reply) != 0)) valid = false;
            if (reply) {
              const int size = xcb_get_property_value_length(reply);
              if (size < 0 || transfer.data.size() + static_cast<size_t>(size) > 1024 * 1024) valid = false;
              else if (size) transfer.data.append(static_cast<const char*>(xcb_get_property_value(reply)), static_cast<size_t>(size));
              transfer.complete = size == 0;
              std::free(reply);
            }
            break;
          }
        }
      }
      std::free(event);
    }
  }
  valid = valid && transfers[0].complete && transfers[1].complete && transfers[0].data == transfers[1].data &&
      (transfers[0].data.rfind("cut\n", 0) == 0 || transfers[0].data.rfind("copy\n", 0) == 0);
  for (xcb_window_t window : windows) xcb_destroy_window(connection, window);
  xcb_flush(connection);
  xcb_disconnect(connection);
  if (!valid) std::cerr << "Parallel INCR requestors did not receive matching complete payloads.\n";
  return valid ? 0 : 1;
}

struct Transfer {
  xcb_window_t requestor = XCB_WINDOW_NONE;
  xcb_atom_t property = XCB_ATOM_NONE;
  xcb_atom_t target = XCB_ATOM_NONE;
  std::string payload;
  size_t offset = 0;
  bool started = false;
  bool waiting_gate = false;
};

void SendChunk(xcb_connection_t* connection, Transfer* transfer) {
  constexpr size_t chunk_size = 32 * 1024;
  const size_t size = std::min(chunk_size, transfer->payload.size() - transfer->offset);
  xcb_change_property(connection, XCB_PROP_MODE_REPLACE, transfer->requestor, transfer->property,
                      transfer->target, 8, static_cast<uint32_t>(size),
                      size ? transfer->payload.data() + transfer->offset : nullptr);
  transfer->offset += size;
  xcb_flush(connection);
  if (!size) transfer->started = false;
}

int SelectionOwner(bool stall, const std::string& payload_path) {
  std::string payload;
  if (!stall) {
    std::ifstream input(payload_path, std::ios::binary);
    if (!input.is_open()) return 2;
    payload.assign(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
    if (input.bad() || payload.size() <= 48 * 1024 || payload.size() > 1024 * 1024) return 2;
  }
  int screen_index = 0;
  xcb_connection_t* connection = xcb_connect(nullptr, &screen_index);
  if (!connection || xcb_connection_has_error(connection)) return 2;
  Atoms atoms;
  if (!LoadAtoms(connection, &atoms)) { xcb_disconnect(connection); return 2; }
  auto* screen = xcb_setup_roots_iterator(xcb_get_setup(connection)).data;
  xcb_window_t owner = XCB_WINDOW_NONE;
  if (!screen || !CreateWindow(connection, screen->root, &owner)) { xcb_disconnect(connection); return 2; }
  xcb_set_selection_owner(connection, owner, atoms.clipboard, XCB_CURRENT_TIME);
  xcb_flush(connection);
  if (!WaitOwner(connection, atoms.clipboard, owner)) { xcb_disconnect(connection); return 2; }
  std::cout << "READY\n" << std::flush;
  Transfer transfer;
  bool gate_open = stall;
  while (!xcb_connection_has_error(connection)) {
    pollfd descriptors[2]{{xcb_get_file_descriptor(connection), POLLIN, 0}, {STDIN_FILENO, POLLIN, 0}};
    const int ready = ::poll(descriptors, 2, 100);
    if (ready < 0 && errno != EINTR) break;
    if (descriptors[1].revents & POLLIN) {
      char control[32]{};
      const ssize_t size = ::read(STDIN_FILENO, control, sizeof(control));
      if (size > 0 && std::string(control, static_cast<size_t>(size)).find("GO") != std::string::npos) {
        gate_open = true;
        if (transfer.waiting_gate) { transfer.waiting_gate = false; SendChunk(connection, &transfer); }
      }
    }
    if (descriptors[0].revents & (POLLERR | POLLHUP | POLLNVAL)) break;
    while (auto* event = xcb_poll_for_event(connection)) {
      const uint8_t type = event->response_type & 0x7f;
      if (type == XCB_SELECTION_REQUEST) {
        const auto* request = reinterpret_cast<xcb_selection_request_event_t*>(event);
        const xcb_atom_t property = request->property ? request->property : request->target;
        if (request->target == atoms.targets) {
          const std::array<xcb_atom_t, 2> values{atoms.targets, atoms.gnome};
          xcb_change_property(connection, XCB_PROP_MODE_REPLACE, request->requestor, property, atoms.atom, 32,
                              static_cast<uint32_t>(values.size()), values.data());
          Notify(connection, *request, property);
          std::cout << "TARGETS\n" << std::flush;
        } else if (!stall && request->target == atoms.gnome && !transfer.started) {
          const uint32_t event_mask = XCB_EVENT_MASK_PROPERTY_CHANGE;
          xcb_change_window_attributes(connection, request->requestor, XCB_CW_EVENT_MASK, &event_mask);
          const uint32_t length = static_cast<uint32_t>(payload.size());
          xcb_change_property(connection, XCB_PROP_MODE_REPLACE, request->requestor, property, atoms.incr, 32, 1, &length);
          Notify(connection, *request, property);
          transfer = {request->requestor, property, atoms.gnome, payload, 0, true, false};
          xcb_flush(connection);
          std::cout << "TRANSFER\n" << std::flush;
        } else if (stall && request->target == atoms.gnome) {
          std::cout << "REQUEST\n" << std::flush;
        } else {
          Notify(connection, *request, XCB_ATOM_NONE);
        }
      } else if (type == XCB_PROPERTY_NOTIFY && transfer.started) {
        const auto* changed = reinterpret_cast<const xcb_property_notify_event_t*>(event);
        if (changed->window == transfer.requestor && changed->atom == transfer.property &&
            changed->state == XCB_PROPERTY_DELETE) {
          if (!gate_open) {
            transfer.waiting_gate = true;
            std::cout << "WAITING\n" << std::flush;
          }
          else SendChunk(connection, &transfer);
        }
      }
      std::free(event);
    }
    xcb_flush(connection);
  }
  xcb_disconnect(connection);
  return 0;
}
}  // namespace

int main(int argc, char** argv) {
  if (argc == 2 && std::strcmp(argv[1], "parallel") == 0) return ParallelRequestors();
  if (argc == 2 && std::strcmp(argv[1], "stall") == 0) return SelectionOwner(true, {});
  if (argc == 3 && std::strcmp(argv[1], "serve-incr") == 0) return SelectionOwner(false, argv[2]);
  std::cerr << "Expected parallel, stall, or serve-incr <payload-path>.\n";
  return 2;
}

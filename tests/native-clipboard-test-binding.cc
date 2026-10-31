#include <node_api.h>
#include "../native/src/clipboard-win.h"
#include <memory>
#include <string>

namespace {
struct TestSession {
  std::shared_ptr<SessionState> state = std::make_shared<SessionState>();
};
const napi_type_tag tag = { 0x2268ec97bacd4e13ULL, 0xa61bd8f501724c33ULL };

napi_value Text(napi_env env, const char* value) {
  napi_value result;
  if (napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result) != napi_ok) return nullptr;
  return result;
}

TestSession* Unwrap(napi_env env, napi_value receiver) {
  bool is_tagged = false;
  void* data = nullptr;
  if (napi_check_object_type_tag(env, receiver, &tag, &is_tagged) != napi_ok || !is_tagged ||
      napi_unwrap(env, receiver, &data) != napi_ok || !data) return nullptr;
  return static_cast<TestSession*>(data);
}

napi_value Invoke(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2], receiver;
  if (napi_get_cb_info(env, info, &count, args, &receiver, nullptr) != napi_ok || count != 2) return nullptr;
  auto* session = Unwrap(env, receiver);
  if (!session) { napi_throw_error(env, "InvalidSession", "Invalid test session."); return nullptr; }
  char operation[64]{};
  size_t length = 0;
  if (napi_get_value_string_utf8(env, args[0], operation, sizeof(operation), &length) != napi_ok || length >= sizeof(operation) - 1) {
    napi_throw_error(env, "InvalidRequest", "Invalid operation.");
    return nullptr;
  }
  return StartWindowsClipboardQuery(env, session->state, operation, args[1]);
}

napi_value Close(napi_env env, napi_callback_info info) {
  napi_value receiver;
  if (napi_get_cb_info(env, info, nullptr, nullptr, &receiver, nullptr) != napi_ok) return nullptr;
  auto* session = Unwrap(env, receiver);
  if (!session) { napi_throw_error(env, "InvalidSession", "Invalid test session."); return nullptr; }
  session->state->closed.store(true);
  CloseWindowsClipboardSession(session->state);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

void Finalize(napi_env, void* data, void*) {
  std::unique_ptr<TestSession> session(static_cast<TestSession*>(data));
  if (!session) return;
  session->state->closed.store(true);
  CloseWindowsClipboardSession(session->state);
}

napi_value Open(napi_env env, napi_callback_info) {
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok) return nullptr;
  const napi_property_descriptor methods[] = {
    { "invoke", nullptr, Invoke, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr }
  };
  if (napi_define_properties(env, result, 2, methods) != napi_ok) return nullptr;
  auto session = std::make_unique<TestSession>();
  if (napi_wrap(env, result, session.get(), Finalize, nullptr, nullptr) != napi_ok || napi_type_tag_object(env, result, &tag) != napi_ok) return nullptr;
  session.release();
  return result;
}

#ifdef CLIPBOARD_TESTING
napi_value VerifyStaLifecycle(napi_env env, napi_callback_info) {
  napi_value result;
  if (napi_get_boolean(env, VerifyWindowsClipboardStaLifecycleForTest(), &result) != napi_ok) return nullptr;
  return result;
}
napi_value StartBlockedOwner(napi_env env, napi_callback_info) { return StartWindowsClipboardBlockedOwnerTest(env); }
napi_value PrepareBlockedOwners(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value arg; uint32_t owners = 0;
  if (napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr) != napi_ok || count != 1 || napi_get_value_uint32(env, arg, &owners) != napi_ok || !owners || owners > 16) return nullptr;
  PrepareWindowsClipboardTestOwners(owners);
  napi_value result; napi_get_undefined(env, &result); return result;
}
napi_value WaitBlockedOwner(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value arg, result; uint32_t milliseconds = 0;
  if (napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr) != napi_ok || count != 1 || napi_get_value_uint32(env, arg, &milliseconds) != napi_ok) return nullptr;
  if (napi_get_boolean(env, WaitWindowsClipboardTestOwners(milliseconds), &result) != napi_ok) return nullptr;
  return result;
}
napi_value CloseBlockedOwner(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value arg; uint32_t index = 0;
  if (napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr) != napi_ok || count != 1 || napi_get_value_uint32(env, arg, &index) != napi_ok) return nullptr;
  return CloseWindowsClipboardTestOwner(env, index);
}
napi_value ReleaseBlockedOwner(napi_env env, napi_callback_info) {
  ReleaseWindowsClipboardTestOwner();
  napi_value result; napi_get_undefined(env, &result); return result;
}
#endif

napi_value Init(napi_env env, napi_value exports) {
  napi_value version, major, minor, capabilities, entry, open;
  if (napi_create_object(env, &version) != napi_ok || napi_create_uint32(env, 1, &major) != napi_ok ||
      napi_create_uint32(env, 0, &minor) != napi_ok || napi_set_named_property(env, version, "major", major) != napi_ok ||
      napi_set_named_property(env, version, "minor", minor) != napi_ok || napi_set_named_property(env, exports, "apiVersion", version) != napi_ok ||
      napi_create_object(env, &capabilities) != napi_ok) return nullptr;
  for (const char* operation : { "clipboard.readFiles", "clipboard.writeFiles", "clipboard.acknowledge" }) {
    if (napi_create_object(env, &entry) != napi_ok || napi_set_named_property(env, entry, "status", Text(env, "supported")) != napi_ok ||
        napi_set_named_property(env, capabilities, operation, entry) != napi_ok) return nullptr;
  }
  if (napi_set_named_property(env, exports, "capabilities", capabilities) != napi_ok || napi_create_function(env, "openSession", NAPI_AUTO_LENGTH, Open, nullptr, &open) != napi_ok ||
      napi_set_named_property(env, exports, "openSession", open) != napi_ok) return nullptr;
#ifdef CLIPBOARD_TESTING
  napi_value verify, start_blocked, prepare_blocked, wait_blocked, close_blocked, release_blocked;
  if (napi_create_function(env, "verifyStaLifecycle", NAPI_AUTO_LENGTH, VerifyStaLifecycle, nullptr, &verify) != napi_ok ||
      napi_set_named_property(env, exports, "verifyStaLifecycle", verify) != napi_ok ||
      napi_create_function(env, "startBlockedOwner", NAPI_AUTO_LENGTH, StartBlockedOwner, nullptr, &start_blocked) != napi_ok ||
      napi_set_named_property(env, exports, "startBlockedOwner", start_blocked) != napi_ok ||
      napi_create_function(env, "prepareBlockedOwners", NAPI_AUTO_LENGTH, PrepareBlockedOwners, nullptr, &prepare_blocked) != napi_ok ||
      napi_set_named_property(env, exports, "prepareBlockedOwners", prepare_blocked) != napi_ok ||
      napi_create_function(env, "waitBlockedOwner", NAPI_AUTO_LENGTH, WaitBlockedOwner, nullptr, &wait_blocked) != napi_ok ||
      napi_set_named_property(env, exports, "waitBlockedOwner", wait_blocked) != napi_ok ||
      napi_create_function(env, "closeBlockedOwner", NAPI_AUTO_LENGTH, CloseBlockedOwner, nullptr, &close_blocked) != napi_ok ||
      napi_set_named_property(env, exports, "closeBlockedOwner", close_blocked) != napi_ok ||
      napi_create_function(env, "releaseBlockedOwner", NAPI_AUTO_LENGTH, ReleaseBlockedOwner, nullptr, &release_blocked) != napi_ok ||
      napi_set_named_property(env, exports, "releaseBlockedOwner", release_blocked) != napi_ok) return nullptr;
#endif
  return exports;
}
}

NAPI_MODULE(binding_clipboard_test, Init)

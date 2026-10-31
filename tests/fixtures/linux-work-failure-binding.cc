#include "../../native/src/linux-work.h"

namespace {
struct Fixture { std::shared_ptr<SessionState> state = std::make_shared<SessionState>(); };
Fixture* State(napi_env env) {
  void* data = nullptr;
  napi_get_instance_data(env, &data);
  return static_cast<Fixture*>(data);
}
napi_value FailCompletion(napi_env env, napi_callback_info) {
  return QueueLinuxWork(env, State(env)->state, "test.completion", new int(1),
      [](void*) {}, [](napi_env, napi_status, void*) -> LinuxWorkResult { return {}; },
      [](void* data) { delete static_cast<int*>(data); });
}
napi_value Close(napi_env env, napi_callback_info) {
  auto state = State(env)->state;
  state->closed.store(true);
  return WhenLinuxWorkClosed(env, state);
}
napi_value Initialize(napi_env env, napi_value exports) {
  auto* fixture = new Fixture;
  napi_set_instance_data(env, fixture, [](napi_env, void* data, void*) {
    auto* fixture = static_cast<Fixture*>(data);
    fixture->state->closed.store(true);
    delete fixture;
  }, nullptr);
  const napi_property_descriptor functions[] = {
    {"failCompletion", nullptr, FailCompletion, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, 2, functions);
  return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)

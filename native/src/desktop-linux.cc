#include "desktop-linux.h"

#include <gio/gio.h>

#include <cerrno>
#include <cstring>
#include <dlfcn.h>
#include <filesystem>
#include <memory>
#include <string>

namespace {
struct GioApi {
  void* library = nullptr;
  decltype(&g_file_new_for_path) file_new_for_path = nullptr;
  decltype(&g_file_get_uri) file_get_uri = nullptr;
  decltype(&g_file_query_default_handler_async) file_query_default_handler_async = nullptr;
  decltype(&g_file_query_default_handler_finish) file_query_default_handler_finish = nullptr;
  decltype(&g_app_info_get_default_for_uri_scheme) app_info_get_default_for_uri_scheme = nullptr;
  decltype(&g_app_info_launch_default_for_uri_async) launch_default_for_uri_async = nullptr;
  decltype(&g_app_info_launch_default_for_uri_finish) launch_default_for_uri_finish = nullptr;
  decltype(&g_main_context_new) main_context_new = nullptr;
  decltype(&g_main_context_unref) main_context_unref = nullptr;
  decltype(&g_main_context_push_thread_default) main_context_push_thread_default = nullptr;
  decltype(&g_main_context_pop_thread_default) main_context_pop_thread_default = nullptr;
  decltype(&g_main_loop_new) main_loop_new = nullptr;
  decltype(&g_main_loop_unref) main_loop_unref = nullptr;
  decltype(&g_main_loop_run) main_loop_run = nullptr;
  decltype(&g_main_loop_quit) main_loop_quit = nullptr;
  decltype(&g_cancellable_new) cancellable_new = nullptr;
  decltype(&g_cancellable_cancel) cancellable_cancel = nullptr;
  decltype(&g_timeout_source_new) timeout_source_new = nullptr;
  decltype(&g_source_set_callback) source_set_callback = nullptr;
  decltype(&g_source_attach) source_attach = nullptr;
  decltype(&g_source_destroy) source_destroy = nullptr;
  decltype(&g_source_unref) source_unref = nullptr;
  decltype(&g_object_unref) object_unref = nullptr;
  decltype(&g_error_free) error_free = nullptr;
  decltype(&g_free) free_memory = nullptr;
  decltype(&g_quark_to_string) quark_to_string = nullptr;

  GioApi() {
    library = dlopen("libgio-2.0.so.0", RTLD_NOW | RTLD_LOCAL | RTLD_NODELETE);
    if (!library) return;
#define LOAD_GIO(member, symbol) member = reinterpret_cast<decltype(member)>(dlsym(library, symbol))
    LOAD_GIO(file_new_for_path, "g_file_new_for_path");
    LOAD_GIO(file_get_uri, "g_file_get_uri");
    LOAD_GIO(file_query_default_handler_async, "g_file_query_default_handler_async");
    LOAD_GIO(file_query_default_handler_finish, "g_file_query_default_handler_finish");
    LOAD_GIO(app_info_get_default_for_uri_scheme, "g_app_info_get_default_for_uri_scheme");
    LOAD_GIO(launch_default_for_uri_async, "g_app_info_launch_default_for_uri_async");
    LOAD_GIO(launch_default_for_uri_finish, "g_app_info_launch_default_for_uri_finish");
    LOAD_GIO(main_context_new, "g_main_context_new");
    LOAD_GIO(main_context_unref, "g_main_context_unref");
    LOAD_GIO(main_context_push_thread_default, "g_main_context_push_thread_default");
    LOAD_GIO(main_context_pop_thread_default, "g_main_context_pop_thread_default");
    LOAD_GIO(main_loop_new, "g_main_loop_new");
    LOAD_GIO(main_loop_unref, "g_main_loop_unref");
    LOAD_GIO(main_loop_run, "g_main_loop_run");
    LOAD_GIO(main_loop_quit, "g_main_loop_quit");
    LOAD_GIO(cancellable_new, "g_cancellable_new");
    LOAD_GIO(cancellable_cancel, "g_cancellable_cancel");
    LOAD_GIO(timeout_source_new, "g_timeout_source_new");
    LOAD_GIO(source_set_callback, "g_source_set_callback");
    LOAD_GIO(source_attach, "g_source_attach");
    LOAD_GIO(source_destroy, "g_source_destroy");
    LOAD_GIO(source_unref, "g_source_unref");
    LOAD_GIO(object_unref, "g_object_unref");
    LOAD_GIO(error_free, "g_error_free");
    LOAD_GIO(free_memory, "g_free");
    LOAD_GIO(quark_to_string, "g_quark_to_string");
#undef LOAD_GIO
    if (!Complete()) {
      dlclose(library);
      library = nullptr;
    }
  }

  ~GioApi() { if (library) dlclose(library); }

  bool Complete() const {
    return file_new_for_path && file_get_uri &&
        app_info_get_default_for_uri_scheme && launch_default_for_uri_async &&
        launch_default_for_uri_finish && main_context_new && main_context_unref &&
        main_context_push_thread_default && main_context_pop_thread_default &&
        main_loop_new && main_loop_unref && main_loop_run && main_loop_quit &&
        cancellable_new && cancellable_cancel && timeout_source_new &&
        source_set_callback && source_attach && source_destroy && source_unref &&
        object_unref && error_free && free_memory && quark_to_string;
  }
};

GioApi& Api() {
  static GioApi api;
  return api;
}

template <typename T>
struct ObjectDeleter {
  GioApi* api = nullptr;
  void operator()(T* value) const { if (value) api->object_unref(value); }
};

template <typename T>
using ObjectPtr = std::unique_ptr<T, ObjectDeleter<T>>;

struct ErrorDeleter {
  GioApi* api = nullptr;
  void operator()(GError* value) const { if (value) api->error_free(value); }
};

using ErrorPtr = std::unique_ptr<GError, ErrorDeleter>;

struct StringDeleter {
  GioApi* api = nullptr;
  void operator()(char* value) const { if (value) api->free_memory(value); }
};

using StringPtr = std::unique_ptr<char, StringDeleter>;

struct ContextDeleter {
  GioApi* api = nullptr;
  void operator()(GMainContext* value) const { if (value) api->main_context_unref(value); }
};

struct LoopDeleter {
  GioApi* api = nullptr;
  void operator()(GMainLoop* value) const { if (value) api->main_loop_unref(value); }
};

struct SourceDeleter {
  GioApi* api = nullptr;
  void operator()(GSource* value) const {
    if (value) {
      api->source_destroy(value);
      api->source_unref(value);
    }
  }
};

struct ThreadDefaultContext {
  GioApi* api;
  GMainContext* context;
  ThreadDefaultContext(GioApi* value, GMainContext* main_context)
      : api(value), context(main_context) { api->main_context_push_thread_default(context); }
  ~ThreadDefaultContext() { api->main_context_pop_thread_default(context); }
};

void SetGError(LinuxDesktopResult* result, GioApi* api, const GError* error) {
  if (!error) return;
  result->native_error = error->code;
  const char* domain = api->quark_to_string(error->domain);
  if (domain) result->native_domain = domain;
  if (error->message) result->error = error->message;
  result->cancelled = domain && std::strcmp(domain, "g-io-error-quark") == 0 &&
      error->code == G_IO_ERROR_CANCELLED;
}

void SetCancelled(LinuxDesktopResult* result) {
  result->cancelled = true;
  result->error = "The desktop request was cancelled.";
  result->native_error = G_IO_ERROR_CANCELLED;
  result->native_domain = "g-io-error-quark";
}

struct LaunchState {
  GioApi* api;
  GMainLoop* loop;
  LinuxDesktopResult* result;
  bool success = false;
  ErrorPtr error{nullptr, {nullptr}};
};

void LaunchFinished(GObject*, GAsyncResult* async_result, gpointer data) {
  auto* state = static_cast<LaunchState*>(data);
  GError* error = nullptr;
  try {
    state->success = state->api->launch_default_for_uri_finish(async_result, &error) != FALSE;
    state->error = ErrorPtr(error, {state->api});
    error = nullptr;
    if (state->error) SetGError(state->result, state->api, state->error.get());
  } catch (...) {
    if (error) state->api->error_free(error);
    state->error.reset();
    state->success = false;
    state->result->native_error = ENOMEM;
    state->result->native_domain.clear();
    state->result->error.clear();
  }
  state->api->main_loop_quit(state->loop);
}

struct FileInspectionState {
  GioApi* api;
  GFile* file;
  GMainLoop* loop;
  GAppInfo* handler = nullptr;
  GError* error = nullptr;
};

void FileInspectionFinished(GObject*, GAsyncResult* async_result, gpointer data) {
  auto* state = static_cast<FileInspectionState*>(data);
  state->handler = state->api->file_query_default_handler_finish(
      state->file, async_result, &state->error);
  state->api->main_loop_quit(state->loop);
}

struct CancellationState {
  GioApi* api;
  GCancellable* cancellable;
  const std::atomic<bool>* closed;
  bool cancelled = false;
};

gboolean PollCancellation(gpointer data) {
  auto* state = static_cast<CancellationState*>(data);
  if (!state->closed || !state->closed->load(std::memory_order_acquire)) return G_SOURCE_CONTINUE;
  state->cancelled = true;
  state->api->cancellable_cancel(state->cancellable);
  return G_SOURCE_CONTINUE;
}

LinuxDesktopResult Failure(bool available, int code, const char* domain,
                           const std::string& message, bool cancelled = false) {
  LinuxDesktopResult result;
  result.available = available;
  result.native_error = code;
  result.native_domain = domain ? domain : "";
  result.error = message;
  result.cancelled = cancelled;
  return result;
}

LinuxDesktopResult InspectFileHandler(GioApi* api, GFile* file,
                                     const std::atomic<bool>* closed) {
  if (!api->file_query_default_handler_async || !api->file_query_default_handler_finish) {
    return Failure(false, 0, "", "File handler inspection is unavailable in this GIO version.");
  }
  if (closed && closed->load(std::memory_order_acquire)) {
    return Failure(false, G_IO_ERROR_CANCELLED, "g-io-error-quark",
                   "The desktop request was cancelled.", true);
  }

  std::unique_ptr<GMainContext, ContextDeleter> context(api->main_context_new(), {api});
  if (!context) return Failure(false, ENOMEM, "errno", "Cannot create a GIO main context.");
  std::unique_ptr<GMainLoop, LoopDeleter> loop(api->main_loop_new(context.get(), FALSE), {api});
  if (!loop) return Failure(false, ENOMEM, "errno", "Cannot create a GIO main loop.");
  ObjectPtr<GCancellable> cancellable(api->cancellable_new(), {api});
  if (!cancellable) return Failure(false, ENOMEM, "errno", "Cannot create a GIO cancellation object.");

  ThreadDefaultContext thread_default(api, context.get());
  FileInspectionState inspection{api, file, loop.get()};
  CancellationState cancellation{api, cancellable.get(), closed, false};
  std::unique_ptr<GSource, SourceDeleter> timer(api->timeout_source_new(20), {api});
  if (!timer) return Failure(false, ENOMEM, "errno", "Cannot create a GIO cancellation timer.");
  api->source_set_callback(timer.get(), PollCancellation, &cancellation, nullptr);
  if (api->source_attach(timer.get(), context.get()) == 0) {
    return Failure(false, EIO, "errno", "Cannot attach the GIO cancellation timer.");
  }
  api->file_query_default_handler_async(file, G_PRIORITY_DEFAULT, cancellable.get(),
                                        FileInspectionFinished, &inspection);
  api->main_loop_run(loop.get());
  timer.reset();

  ObjectPtr<GAppInfo> handler(inspection.handler, {api});
  ErrorPtr error(inspection.error, {api});
  LinuxDesktopResult result;
  if (error) {
    SetGError(&result, api, error.get());
    return result;
  }
  if (cancellation.cancelled || (closed && closed->load(std::memory_order_acquire))) {
    return Failure(false, G_IO_ERROR_CANCELLED, "g-io-error-quark",
                   "The desktop request was cancelled.", true);
  }
  result.available = handler != nullptr;
  result.editor = false;
  if (!handler) result.error = "No default application is registered for this target.";
  return result;
}
}

bool ProbeLinuxDesktop() {
  return Api().Complete();
}

LinuxDesktopResult RunLinuxDesktop(const std::string& path, bool trash,
                                   bool inspect_only,
                                   const std::atomic<bool>* closed) {
  GioApi& api = Api();
  if (!api.Complete()) return Failure(false, 0, "", "GIO is not available.");
  if (closed && closed->load(std::memory_order_acquire)) {
    return Failure(false, G_IO_ERROR_CANCELLED, "g-io-error-quark",
                   "The desktop request was cancelled.", true);
  }

  ObjectPtr<GFile> file(nullptr, {&api});
  StringPtr uri(nullptr, {&api});
  const char* requested_uri = "trash:///";
  if (!trash) {
    if (path.empty() || path.find('\0') != std::string::npos ||
        !std::filesystem::path(path).is_absolute()) {
      return Failure(false, EINVAL, "errno", "An absolute file path is required.");
    }
    file.reset(api.file_new_for_path(path.c_str()));
    if (!file) return Failure(false, ENOMEM, "errno", "Cannot create a file URI.");
    uri.reset(api.file_get_uri(file.get()));
    if (!uri) return Failure(false, ENOMEM, "errno", "Cannot convert the file path to a URI.");
    requested_uri = uri.get();
  }

  LinuxDesktopResult result;
  result.editor = false;
  if (inspect_only) {
    if (!trash) return InspectFileHandler(&api, file.get(), closed);
    ObjectPtr<GAppInfo> handler(api.app_info_get_default_for_uri_scheme("trash"), {&api});
    if (closed && closed->load(std::memory_order_acquire)) {
      return Failure(false, G_IO_ERROR_CANCELLED, "g-io-error-quark",
                     "The desktop request was cancelled.", true);
    }
    result.available = handler != nullptr;
    if (!handler) result.error = "No default application is registered for this target.";
    return result;
  }

  if (closed && closed->load(std::memory_order_acquire)) {
    return Failure(false, G_IO_ERROR_CANCELLED, "g-io-error-quark",
                   "The desktop request was cancelled.", true);
  }

  std::unique_ptr<GMainContext, ContextDeleter> context(api.main_context_new(), {&api});
  if (!context) return Failure(false, ENOMEM, "errno", "Cannot create a GIO main context.");
  std::unique_ptr<GMainLoop, LoopDeleter> loop(api.main_loop_new(context.get(), FALSE), {&api});
  if (!loop) return Failure(false, ENOMEM, "errno", "Cannot create a GIO main loop.");
  ObjectPtr<GCancellable> cancellable(api.cancellable_new(), {&api});
  if (!cancellable) return Failure(false, ENOMEM, "errno", "Cannot create a GIO cancellation object.");

  ThreadDefaultContext thread_default(&api, context.get());
  LaunchState launch{&api, loop.get(), &result};
  CancellationState cancellation{&api, cancellable.get(), closed, false};
  std::unique_ptr<GSource, SourceDeleter> timer(api.timeout_source_new(20), {&api});
  if (!timer) return Failure(false, ENOMEM, "errno", "Cannot create a GIO cancellation timer.");
  api.source_set_callback(timer.get(), PollCancellation, &cancellation, nullptr);
  if (api.source_attach(timer.get(), context.get()) == 0) {
    return Failure(false, EIO, "errno", "Cannot attach the GIO cancellation timer.");
  }

  if (closed && closed->load(std::memory_order_acquire)) {
    return Failure(false, G_IO_ERROR_CANCELLED, "g-io-error-quark",
                   "The desktop request was cancelled.", true);
  }
  result.available = true;
  result.submitted = true;
  api.launch_default_for_uri_async(requested_uri, nullptr, cancellable.get(), LaunchFinished, &launch);
  api.main_loop_run(loop.get());
  timer.reset();
  if (cancellation.cancelled && !launch.success && !result.cancelled) SetCancelled(&result);
  if (!launch.success) {
    if (result.native_domain == "g-io-error-quark" &&
        (result.native_error == G_IO_ERROR_NOT_SUPPORTED ||
         result.native_error == G_IO_ERROR_NOT_FOUND)) {
      result.available = false;
    }
    return result;
  }
  result.requested = true;
  return result;
}

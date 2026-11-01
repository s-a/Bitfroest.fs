function(add_windows_test_module name)
  add_library(${name} MODULE ${ARGN} "${CMAKE_CURRENT_SOURCE_DIR}/src/host-loader-win.cc")
  target_compile_features(${name} PRIVATE cxx_std_17)
  target_compile_definitions(${name} PRIVATE NAPI_VERSION=8)
  target_include_directories(${name} PRIVATE "${NODE_INCLUDE_DIR}")
  target_link_libraries(${name} PRIVATE "${NODE_LIBRARY}" delayimp shell32 shlwapi ole32 user32 uuid psapi advapi32)
  target_link_options(${name} PRIVATE /DELAYLOAD:node.exe)
  target_compile_options(${name} PRIVATE /W4 /WX /EHsc)
  set_target_properties(${name} PROPERTIES PREFIX "" SUFFIX ".node")
endfunction()

add_windows_test_module(clipboard_test
  "${CMAKE_CURRENT_LIST_DIR}/native-clipboard-test-binding.cc"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/clipboard-win.cc"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/clipboard-ole-engine.cc")
target_compile_definitions(clipboard_test PRIVATE CLIPBOARD_TESTING)

add_executable(clipboard_engine_tests
  "${CMAKE_CURRENT_LIST_DIR}/native-clipboard-engine.test.cc"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/clipboard-ole-engine.cc")
target_compile_features(clipboard_engine_tests PRIVATE cxx_std_17)
target_compile_options(clipboard_engine_tests PRIVATE /W4 /WX /EHsc)
target_link_libraries(clipboard_engine_tests PRIVATE ole32 shell32 uuid user32)

add_windows_test_module(locks_module_fixture
  "${CMAKE_CURRENT_LIST_DIR}/fixtures/native-locks-module-fixture.cc")

add_windows_test_module(locks_detach_test
  "${CMAKE_CURRENT_LIST_DIR}/fixtures/native-locks-detach-binding.cc"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/locks-win.cc"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/windows-async-work.cc")
target_compile_definitions(locks_detach_test PRIVATE NATIVE_LOCKS_TESTING)

add_executable(icons_render_tests "${CMAKE_CURRENT_LIST_DIR}/native-icons-render.test.cc")
target_compile_features(icons_render_tests PRIVATE cxx_std_17)
target_compile_options(icons_render_tests PRIVATE /W4 /WX /EHsc)
target_link_libraries(icons_render_tests PRIVATE gdiplus ole32 shell32 user32 gdi32)
enable_testing()
add_test(NAME icons_render_tests COMMAND icons_render_tests)

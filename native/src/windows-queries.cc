#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winnetwk.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <memory>
#include <string>
#include <vector>
#include "windows-queries.h"
#include "utf8-decoder.h"
#include "network-bridge-win.h"
#include "windows-async-work.h"

namespace {
constexpr size_t max_bytes = 1024 * 1024;
struct Query {
  std::shared_ptr<SessionState> state;
  std::string operation;
  napi_deferred deferred = nullptr;
  DWORD native_error = 0;
  const char* error = nullptr;
  UINT codepage = 0;
  CPINFOEXW info{};
  double offset = 0;
  double map_start = 0;
  bool text_only = false;
  bool final = true;
  std::vector<unsigned char> bytes;
  std::vector<unsigned char> input_pending;
  std::vector<unsigned char> pending;
  std::vector<std::wstring> drives;
  std::vector<std::wstring> mappings;
  std::wstring text;
  std::vector<double> map;
};

napi_value Fail(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message);
  return nullptr;
}
#define CHECK(call) do { if ((call) != napi_ok) return Fail(env, "BindingFailure", "Native query binding failed."); } while (false)
napi_value Text(napi_env env, const char* value) {
  napi_value result;
  CHECK(napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result));
  return result;
}
napi_value Wide(napi_env env, const std::wstring& value) {
  napi_value result;
  CHECK(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(value.data()), value.size(), &result));
  return result;
}
bool Number(napi_env env, napi_value request, const char* key, double* output) {
  napi_value value;
  return napi_get_named_property(env, request, key, &value) == napi_ok &&
    napi_get_value_double(env, value, output) == napi_ok && std::isfinite(*output) && std::floor(*output) == *output;
}
bool Has(napi_env env, napi_value request, const char* key) {
  bool found = false;
  napi_has_named_property(env, request, key, &found);
  return found;
}
bool String(napi_env env, napi_value value, std::wstring* output) {
  size_t length;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || length > 32767) return false;
  std::vector<char16_t> buffer(length + 1);
  if (napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
  output->assign(buffer.begin(), buffer.begin() + length);
  return output->find(L'\0') == std::wstring::npos;
}
bool Stateful(UINT cp) {
  return (cp >= 50220 && cp <= 50229) || cp == 52936 || cp == 65000 || (cp >= 57002 && cp <= 57011);
}

void EmitCodepageChars(Query* query, const wchar_t* chars, int length, size_t start) {
  for (int index = 0; index < length; ++index) {
    wchar_t value = chars[index] == L'\ufffd' ? query->info.UnicodeDefaultChar : chars[index];
    query->text.push_back(value);
    if (!query->text_only) query->map.push_back(query->offset + static_cast<double>(start));
  }
}

int DecodeGB18030Sequence(Query* query, const unsigned char* bytes, size_t count, size_t map_start) {
  wchar_t chars[8]{};
  const int length = MultiByteToWideChar(54936, MB_ERR_INVALID_CHARS,
    reinterpret_cast<const char*>(bytes), static_cast<int>(count), chars, 8);
  if (!length) return 0;
  EmitCodepageChars(query, chars, length, map_start);
  return length;
}

bool GB18030Lead(unsigned char byte) { return byte >= 0x81 && byte <= 0xfe; }
bool GB18030TwoByteTrail(unsigned char byte) {
  return (byte >= 0x40 && byte <= 0x7e) || (byte >= 0x80 && byte <= 0xfe);
}
bool GB18030FourByteDigit(unsigned char byte) { return byte >= 0x30 && byte <= 0x39; }

void EmitGB18030Fallback(Query* query, unsigned char byte, size_t map_start) {
  const wchar_t value = byte <= 0x7f ? static_cast<wchar_t>(byte) : query->info.UnicodeDefaultChar;
  query->text.push_back(value);
  if (!query->text_only) query->map.push_back(query->offset + static_cast<double>(map_start));
}

void DecodeGB18030(Query* query) {
  std::vector<unsigned char> pending;
  pending.reserve(4);
  size_t map_start = 0;
  auto process = [&](bool flush) {
    bool emitted = false;
    while (!pending.empty()) {
      const unsigned char first = pending[0];
      if (!GB18030Lead(first)) {
        EmitGB18030Fallback(query, first, map_start);
        pending.erase(pending.begin());
        emitted = true;
        continue;
      }
      if (pending.size() < 2) {
        if (!flush) break;
        EmitGB18030Fallback(query, first, map_start);
        pending.erase(pending.begin());
        emitted = true;
        continue;
      }
      const unsigned char second = pending[1];
      if (GB18030TwoByteTrail(second)) {
        const int length = DecodeGB18030Sequence(query, pending.data(), 2, map_start);
        if (length) {
          pending.erase(pending.begin(), pending.begin() + 2);
        } else {
          EmitGB18030Fallback(query, first, map_start);
          pending.erase(pending.begin());
        }
        emitted = true;
        continue;
      }
      if (GB18030FourByteDigit(second)) {
        if (pending.size() < 4) {
          if (!flush) break;
          EmitGB18030Fallback(query, first, map_start);
          pending.erase(pending.begin());
          emitted = true;
          continue;
        }
        if (GB18030Lead(pending[2]) && GB18030FourByteDigit(pending[3])) {
          const int length = DecodeGB18030Sequence(query, pending.data(), 4, map_start);
          if (length) {
            pending.erase(pending.begin(), pending.begin() + 4);
          } else {
            for (size_t index = 0; index < 4; ++index) EmitGB18030Fallback(query, pending[index], map_start);
            pending.erase(pending.begin(), pending.begin() + 4);
          }
          emitted = true;
          continue;
        }
        EmitGB18030Fallback(query, first, map_start);
        pending.erase(pending.begin());
        emitted = true;
        continue;
      }
      EmitGB18030Fallback(query, first, map_start);
      pending.erase(pending.begin());
      emitted = true;
    }
    return emitted;
  };
  for (size_t position = 0; position < query->bytes.size(); ++position) {
    if ((position & 0xfff) == 0 && query->state->closed.load()) return;
    pending.push_back(query->bytes[position]);
    if (process(false)) map_start = position + 1;
  }
  process(true);
  if (!query->text_only) query->map.push_back(query->offset + static_cast<double>(query->bytes.size()));
}

void ResolveNetwork(Query* query) {
  if (!ResolveNetworkMappings(query->drives, &query->mappings, &query->native_error)) {
    query->error = "NativeFailure";
  }
}

void Decode(Query* query) {
  const UINT cp = query->info.CodePage;
  if (cp == CP_UTF8) {
    auto decoded = DecodeUtf8Chunk(query->bytes, {}, query->offset, query->offset, true,
                                   query->text_only, &query->state->closed);
    if (decoded.cancelled) return;
    query->text.assign(decoded.text.begin(), decoded.text.end());
    query->map = std::move(decoded.map);
    return;
  }
  if (cp == 54936) {
    DecodeGB18030(query);
    return;
  }
  if (Stateful(cp) || query->info.MaxCharSize > 2) {
    query->error = "UnsupportedEncoding";
    return;
  }
  size_t position = 0;
  while (position < query->bytes.size()) {
    if ((position & 0xfff) == 0 && query->state->closed.load()) return;
    const size_t start = position;
    const bool lead = IsDBCSLeadByteEx(cp, query->bytes[position]) != FALSE;
    const size_t count = lead && position + 1 < query->bytes.size() ? 2 : 1;
    wchar_t chars[8]{};
    int length = 0;
    if (lead && count == 1) { chars[0] = query->info.UnicodeDefaultChar; length = 1; }
    else if (cp == 20127 && query->bytes[position] > 127) { chars[0] = L'?'; length = 1; }
    else length = MultiByteToWideChar(cp, count == 2 ? MB_ERR_INVALID_CHARS : 0, reinterpret_cast<const char*>(query->bytes.data() + position), static_cast<int>(count), chars, 8);
    if (!length && GetLastError() == ERROR_NO_UNICODE_TRANSLATION) {
      chars[0] = query->info.UnicodeDefaultChar;
      length = 1;
    }
    if (!length) {
      query->native_error = GetLastError();
      query->error = "UnsupportedEncoding";
      return;
    }
    for (int index = 0; index < length; ++index) {
      if (chars[index] == L'\ufffd') chars[index] = query->info.UnicodeDefaultChar;
    }
    query->text.append(chars, static_cast<size_t>(length));
    if (!query->text_only) for (int index = 0; index < length; ++index) query->map.push_back(query->offset + static_cast<double>(start));
    position += count;
  }
  if (!query->text_only) query->map.push_back(query->offset + static_cast<double>(query->bytes.size()));
}

void EmitAbsoluteChars(Query* query, const wchar_t* chars, int length, double map_position) {
  for (int index = 0; index < length; ++index) {
    const wchar_t value = chars[index] == L'\ufffd' ? query->info.UnicodeDefaultChar : chars[index];
    query->text.push_back(value);
    if (!query->text_only) query->map.push_back(map_position);
  }
}

bool DecodeGB18030SequenceAt(Query* query, const unsigned char* bytes, size_t count, double map_position) {
  wchar_t chars[8]{};
  const int length = MultiByteToWideChar(54936, MB_ERR_INVALID_CHARS,
    reinterpret_cast<const char*>(bytes), static_cast<int>(count), chars, 8);
  if (!length) return false;
  EmitAbsoluteChars(query, chars, length, map_position);
  return true;
}

void EmitGB18030FallbackAt(Query* query, unsigned char byte, double map_position) {
  const wchar_t value = byte <= 0x7f ? static_cast<wchar_t>(byte) : query->info.UnicodeDefaultChar;
  query->text.push_back(value);
  if (!query->text_only) query->map.push_back(map_position);
}

void DecodeGB18030Chunk(Query* query) {
  std::vector<unsigned char> input;
  input.reserve(query->input_pending.size() + query->bytes.size());
  input.insert(input.end(), query->input_pending.begin(), query->input_pending.end());
  input.insert(input.end(), query->bytes.begin(), query->bytes.end());
  const double input_start = query->offset - static_cast<double>(query->input_pending.size());
  double map_start = query->map_start;
  std::vector<unsigned char> parser;
  parser.reserve(4);
  auto process = [&](bool flush) {
    bool emitted = false;
    while (!parser.empty()) {
      const unsigned char first = parser[0];
      if (!GB18030Lead(first)) {
        EmitGB18030FallbackAt(query, first, map_start);
        parser.erase(parser.begin());
        emitted = true;
        continue;
      }
      if (parser.size() < 2) {
        if (!flush) break;
        EmitGB18030FallbackAt(query, first, map_start);
        parser.erase(parser.begin());
        emitted = true;
        continue;
      }
      const unsigned char second = parser[1];
      if (GB18030TwoByteTrail(second)) {
        if (DecodeGB18030SequenceAt(query, parser.data(), 2, map_start)) {
          parser.erase(parser.begin(), parser.begin() + 2);
        } else {
          EmitGB18030FallbackAt(query, first, map_start);
          parser.erase(parser.begin());
        }
        emitted = true;
        continue;
      }
      if (GB18030FourByteDigit(second)) {
        if (parser.size() < 4) {
          if (!flush) break;
          EmitGB18030FallbackAt(query, first, map_start);
          parser.erase(parser.begin());
          emitted = true;
          continue;
        }
        if (GB18030Lead(parser[2]) && GB18030FourByteDigit(parser[3])) {
          if (DecodeGB18030SequenceAt(query, parser.data(), 4, map_start)) {
            parser.erase(parser.begin(), parser.begin() + 4);
          } else {
            for (size_t index = 0; index < 4; ++index) EmitGB18030FallbackAt(query, parser[index], map_start);
            parser.erase(parser.begin(), parser.begin() + 4);
          }
          emitted = true;
          continue;
        }
        EmitGB18030FallbackAt(query, first, map_start);
        parser.erase(parser.begin());
        emitted = true;
        continue;
      }
      EmitGB18030FallbackAt(query, first, map_start);
      parser.erase(parser.begin());
      emitted = true;
    }
    return emitted;
  };
  for (size_t position = 0; position < input.size(); ++position) {
    if ((position & 0xfff) == 0 && query->state->closed.load()) return;
    parser.push_back(input[position]);
    if (process(false)) map_start = input_start + static_cast<double>(position + 1);
  }
  if (query->final) {
    process(true);
    map_start = input_start + static_cast<double>(input.size());
    if (!query->text_only) query->map.push_back(map_start);
  }
  query->pending = std::move(parser);
  query->map_start = map_start;
}

void DecodeSimpleChunk(Query* query) {
  std::vector<unsigned char> combined;
  combined.reserve(query->input_pending.size() + query->bytes.size());
  combined.insert(combined.end(), query->input_pending.begin(), query->input_pending.end());
  combined.insert(combined.end(), query->bytes.begin(), query->bytes.end());
  const double input_start = query->offset - static_cast<double>(query->input_pending.size());
  const double input_end = query->offset + static_cast<double>(query->bytes.size());
  const double original_offset = query->offset;
  size_t decode_length = combined.size();
  query->pending.clear();
  if (!query->final && decode_length && IsDBCSLeadByteEx(query->info.CodePage, combined.back())) {
    query->pending.push_back(combined.back());
    --decode_length;
  }
  if (query->state->closed.load()) return;
  combined.resize(decode_length);
  query->bytes = std::move(combined);
  query->offset = input_start;
  Decode(query);
  query->offset = original_offset;
  if (!query->error && !query->final && !query->text_only && !query->map.empty()) query->map.pop_back();
  query->map_start = input_start + static_cast<double>(decode_length);
  if (query->final) query->map_start = input_end;
}

void DecodeChunk(Query* query) {
  const UINT cp = query->info.CodePage;
  if (Stateful(cp) || (cp != CP_UTF8 && cp != 54936 && query->info.MaxCharSize > 2)) {
    query->error = "UnsupportedEncoding";
    return;
  }
  if (cp == CP_UTF8) {
    auto decoded = DecodeUtf8Chunk(query->bytes, query->input_pending, query->offset,
                                   query->map_start, query->final, query->text_only,
                                   &query->state->closed);
    if (decoded.cancelled) return;
    query->text.assign(decoded.text.begin(), decoded.text.end());
    query->map = std::move(decoded.map);
    query->pending = std::move(decoded.pending);
    query->map_start = decoded.map_start;
  } else if (cp == 54936) {
    DecodeGB18030Chunk(query);
  } else {
    DecodeSimpleChunk(query);
  }
}

void Execute(napi_env, void* data) {
  auto* query = static_cast<Query*>(data);
  try {
    if (query->operation == "paths.resolveNetwork") { ResolveNetwork(query); return; }
    if (!GetCPInfoExW(query->codepage, 0, &query->info)) {
      query->native_error = GetLastError();
      query->error = "UnsupportedEncoding";
      return;
    }
    if (query->operation == "encoding.decodeBlock") Decode(query);
    if (query->operation == "encoding.decodeChunk") DecodeChunk(query);
  } catch (const std::bad_alloc&) { query->error = "ResourceExhausted"; }
    catch (...) { query->error = "NativeFailure"; }
}

napi_value Result(napi_env env, const Query& query) {
  napi_value result;
  CHECK(napi_create_object(env, &result));
  if (query.operation == "paths.resolveNetwork") {
    napi_value mappings;
    CHECK(napi_create_object(env, &mappings));
    for (size_t i = 0; i < query.drives.size(); ++i) {
      napi_value value, key = Wide(env, query.drives[i]);
      if (query.mappings[i].empty()) CHECK(napi_get_null(env, &value));
      else value = Wide(env, query.mappings[i]);
      CHECK(napi_set_property(env, mappings, key, value));
    }
    CHECK(napi_set_named_property(env, result, "mappings", mappings));
  } else if (query.operation == "encoding.describe") {
    napi_value cp, size, supported;
    CHECK(napi_create_uint32(env, query.info.CodePage, &cp));
    CHECK(napi_create_uint32(env, query.info.MaxCharSize, &size));
    CHECK(napi_get_boolean(env, query.info.CodePage == CP_UTF8 || query.info.CodePage == 54936 || (!Stateful(query.info.CodePage) && query.info.MaxCharSize <= 2), &supported));
    CHECK(napi_set_named_property(env, result, "codepage", cp));
    CHECK(napi_set_named_property(env, result, "maxCharSize", size));
    CHECK(napi_set_named_property(env, result, "name", Wide(env, query.info.CodePageName)));
    CHECK(napi_set_named_property(env, result, "blockDecoding", supported));
  } else {
    CHECK(napi_set_named_property(env, result, "text", Wide(env, query.text)));
    CHECK(napi_set_named_property(env, result, "encoding", Text(env, std::to_string(query.info.CodePage).c_str())));
    if (query.operation == "encoding.decodeChunk") {
      napi_value pending, map_start;
      void* buffer = nullptr;
      CHECK(napi_create_buffer(env, query.pending.size(), &buffer, &pending));
      if (!query.pending.empty()) std::memcpy(buffer, query.pending.data(), query.pending.size());
      CHECK(napi_create_double(env, query.map_start, &map_start));
      CHECK(napi_set_named_property(env, result, "pending", pending));
      CHECK(napi_set_named_property(env, result, "mapStart", map_start));
    }
    if (!query.text_only) {
      napi_value map;
      CHECK(napi_create_array_with_length(env, query.map.size(), &map));
      for (size_t i = 0; i < query.map.size(); ++i) {
        napi_value index;
        CHECK(napi_create_double(env, query.map[i], &index));
        CHECK(napi_set_element(env, map, static_cast<uint32_t>(i), index));
      }
      CHECK(napi_set_named_property(env, result, "map", map));
    }
  }
  return result;
}

void Complete(napi_env env, napi_status status, void* data) {
  auto* query = static_cast<Query*>(data);
  const char* code = query->state->closed ? "SessionClosed" : status != napi_ok ? "Cancelled" : query->error;
  if (code) {
    napi_value error, native;
    if (napi_create_error(env, Text(env, code), Text(env, "Native query failed."), &error) != napi_ok) return;
    napi_create_uint32(env, query->native_error, &native);
    napi_set_named_property(env, error, "nativeCode", native);
    napi_set_named_property(env, error, "operation", Text(env, query->operation.c_str()));
    napi_reject_deferred(env, query->deferred, error);
  } else {
    napi_value result = Result(env, *query);
    if (result) napi_resolve_deferred(env, query->deferred, result);
  }
}
}

bool IsWindowsQuery(const char* operation) {
  return std::strcmp(operation, "paths.resolveNetwork") == 0 || std::strcmp(operation, "encoding.describe") == 0 ||
    std::strcmp(operation, "encoding.decodeBlock") == 0 || std::strcmp(operation, "encoding.decodeChunk") == 0;
}

napi_value StartWindowsQuery(napi_env env, const std::shared_ptr<SessionState>& state, const char* operation, napi_value request) {
  napi_valuetype type;
  if (napi_typeof(env, request, &type) != napi_ok || type != napi_object) return Fail(env, "InvalidRequest", "A query object is required.");
  auto query = std::make_unique<Query>();
  query->state = state;
  query->operation = operation;
  if (query->operation == "paths.resolveNetwork") {
    napi_value drives;
    bool array = false;
    uint32_t count;
    if (napi_get_named_property(env, request, "drives", &drives) != napi_ok || napi_is_array(env, drives, &array) != napi_ok || !array ||
        napi_get_array_length(env, drives, &count) != napi_ok || count > 26) return Fail(env, "InvalidRequest", "At most 26 drive roots are required.");
    for (uint32_t i = 0; i < count; ++i) {
      napi_value value;
      std::wstring drive;
      CHECK(napi_get_element(env, drives, i, &value));
      if (!String(env, value, &drive) || drive.size() != 2 || drive[1] != L':' ||
          !((drive[0] >= L'A' && drive[0] <= L'Z') || (drive[0] >= L'a' && drive[0] <= L'z'))) return Fail(env, "InvalidRequest", "Only drive roots such as C: are allowed.");
      if (drive[0] >= L'a' && drive[0] <= L'z') drive[0] -= L'a' - L'A';
      if (std::find(query->drives.begin(), query->drives.end(), drive) == query->drives.end()) query->drives.push_back(drive);
    }
  } else {
    double cp;
    if (!Number(env, request, "codepage", &cp) || cp < 0 || cp > 65535) return Fail(env, "InvalidRequest", "An integer codepage identifier is required.");
    query->codepage = static_cast<UINT>(cp);
    if (query->operation == "encoding.decodeBlock" || query->operation == "encoding.decodeChunk") {
      napi_value bytes;
      bool buffer = false;
      void* data;
      size_t length;
      if (napi_get_named_property(env, request, "bytes", &bytes) != napi_ok || napi_is_buffer(env, bytes, &buffer) != napi_ok || !buffer ||
          napi_get_buffer_info(env, bytes, &data, &length) != napi_ok || length > max_bytes) return Fail(env, "InvalidRequest", "A buffer of at most one MiB is required.");
      if (Has(env, request, "offset") && (!Number(env, request, "offset", &query->offset) || query->offset < 0 || query->offset > 9007199254740991.0 - static_cast<double>(length))) return Fail(env, "InvalidRequest", "The byte offset is outside the safe integer range.");
      if (Has(env, request, "textOnly")) {
        napi_value text_only;
        CHECK(napi_get_named_property(env, request, "textOnly", &text_only));
        if (napi_get_value_bool(env, text_only, &query->text_only) != napi_ok) return Fail(env, "InvalidRequest", "textOnly must be boolean.");
      }
      if (query->operation == "encoding.decodeBlock") {
        query->map_start = query->offset;
      } else {
        napi_value pending, final;
        bool pending_buffer = false;
        void* pending_data = nullptr;
        size_t pending_length = 0;
        if (napi_get_named_property(env, request, "pending", &pending) != napi_ok || napi_is_buffer(env, pending, &pending_buffer) != napi_ok || !pending_buffer ||
            napi_get_buffer_info(env, pending, &pending_data, &pending_length) != napi_ok || pending_length > 3) return Fail(env, "InvalidRequest", "Decoder carry must be a buffer of at most three bytes.");
        if (pending_length) query->input_pending.assign(static_cast<unsigned char*>(pending_data), static_cast<unsigned char*>(pending_data) + pending_length);
        if (napi_get_named_property(env, request, "final", &final) != napi_ok || napi_get_value_bool(env, final, &query->final) != napi_ok) return Fail(env, "InvalidRequest", "final must be boolean.");
        if (!Has(env, request, "offset") || !Number(env, request, "mapStart", &query->map_start) || query->map_start < 0 ||
            query->offset < static_cast<double>(pending_length) ||
            query->map_start < query->offset - static_cast<double>(pending_length) || query->map_start > query->offset) return Fail(env, "InvalidRequest", "Decoder carry offsets must be contiguous and safe.");
      }
      if (length) query->bytes.assign(static_cast<unsigned char*>(data), static_cast<unsigned char*>(data) + length);
    }
  }
  napi_value promise;
  CHECK(napi_create_promise(env, &query->deferred, &promise));
  if (QueueWindowsWork(env, operation, std::move(query), Execute, Complete) != napi_ok) {
    return Fail(env, "BindingFailure", "Cannot queue native query.");
  }
  return promise;
}

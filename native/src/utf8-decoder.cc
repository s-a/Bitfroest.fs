#include "utf8-decoder.h"

Utf8DecodedBlock DecodeUtf8Block(const std::vector<unsigned char>& bytes, double offset, bool text_only) {
  Utf8DecodedBlock result;
  uint32_t codepoint = 0;
  unsigned remaining = 0, lower = 0x80, upper = 0xbf;
  size_t start = 0;
  auto emit = [&](uint32_t value) {
    if (value <= 0xffff) {
      result.text.push_back(static_cast<char16_t>(value));
      if (!text_only) result.map.push_back(offset + static_cast<double>(start));
    } else {
      value -= 0x10000;
      result.text.push_back(static_cast<char16_t>(0xd800 + (value >> 10)));
      result.text.push_back(static_cast<char16_t>(0xdc00 + (value & 0x3ff)));
      if (!text_only) {
        result.map.push_back(offset + static_cast<double>(start));
        result.map.push_back(offset + static_cast<double>(start));
      }
    }
  };
  for (size_t index = 0; index < bytes.size(); ++index) {
    const unsigned byte = bytes[index];
    const size_t before = result.text.size();
    bool consumed = false;
    if (remaining) {
      if (byte >= lower && byte <= upper) {
        codepoint = (codepoint << 6) | (byte & 0x3f);
        --remaining;
        lower = 0x80; upper = 0xbf;
        if (!remaining) emit(codepoint);
        consumed = true;
      } else {
        emit(0xfffd);
        remaining = 0;
      }
    }
    if (!consumed) {
      lower = 0x80; upper = 0xbf;
      if (byte <= 0x7f) emit(byte);
      else if (byte >= 0xc2 && byte <= 0xdf) { codepoint = byte & 0x1f; remaining = 1; }
      else if (byte >= 0xe0 && byte <= 0xef) {
        codepoint = byte & 0x0f; remaining = 2;
        if (byte == 0xe0) lower = 0xa0;
        if (byte == 0xed) upper = 0x9f;
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        codepoint = byte & 0x07; remaining = 3;
        if (byte == 0xf0) lower = 0x90;
        if (byte == 0xf4) upper = 0x8f;
      } else emit(0xfffd);
    }
    if (result.text.size() != before) start = index + 1;
  }
  if (remaining) emit(0xfffd);
  if (!text_only) result.map.push_back(offset + static_cast<double>(bytes.size()));
  return result;
}

Utf8DecodedChunk DecodeUtf8Chunk(const std::vector<unsigned char>& bytes,
                                 const std::vector<unsigned char>& pending,
                                 double offset, double map_start, bool final,
                                 bool text_only, const std::atomic<bool>* cancelled) {
  Utf8DecodedChunk result;
  result.map_start = map_start;
  const double start_offset = offset - static_cast<double>(pending.size());
  std::vector<unsigned char> input;
  input.reserve(pending.size() + bytes.size());
  input.insert(input.end(), pending.begin(), pending.end());
  input.insert(input.end(), bytes.begin(), bytes.end());
  uint32_t codepoint = 0;
  unsigned remaining = 0, lower = 0x80, upper = 0xbf;
  size_t sequence_start = 0;
  auto emit = [&](uint32_t value) {
    if (value <= 0xffff) {
      result.text.push_back(static_cast<char16_t>(value));
      if (!text_only) result.map.push_back(map_start);
    } else {
      value -= 0x10000;
      result.text.push_back(static_cast<char16_t>(0xd800 + (value >> 10)));
      result.text.push_back(static_cast<char16_t>(0xdc00 + (value & 0x3ff)));
      if (!text_only) {
        result.map.push_back(map_start);
        result.map.push_back(map_start);
      }
    }
  };
  for (size_t index = 0; index < input.size(); ++index) {
    if ((index & 0xfff) == 0 && cancelled && cancelled->load()) {
      result.cancelled = true;
      return result;
    }
    const unsigned byte = input[index];
    const size_t before = result.text.size();
    bool consumed = false;
    if (remaining) {
      if (byte >= lower && byte <= upper) {
        codepoint = (codepoint << 6) | (byte & 0x3f);
        --remaining;
        lower = 0x80;
        upper = 0xbf;
        if (!remaining) emit(codepoint);
        consumed = true;
      } else {
        emit(0xfffd);
        remaining = 0;
      }
    }
    if (!consumed) {
      lower = 0x80;
      upper = 0xbf;
      if (byte <= 0x7f) emit(byte);
      else if (byte >= 0xc2 && byte <= 0xdf) {
        sequence_start = index;
        codepoint = byte & 0x1f;
        remaining = 1;
      } else if (byte >= 0xe0 && byte <= 0xef) {
        sequence_start = index;
        codepoint = byte & 0x0f;
        remaining = 2;
        if (byte == 0xe0) lower = 0xa0;
        if (byte == 0xed) upper = 0x9f;
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        sequence_start = index;
        codepoint = byte & 0x07;
        remaining = 3;
        if (byte == 0xf0) lower = 0x90;
        if (byte == 0xf4) upper = 0x8f;
      } else emit(0xfffd);
    }
    if (result.text.size() != before) map_start = start_offset + static_cast<double>(index + 1);
  }
  if (remaining) {
    if (final) {
      emit(0xfffd);
    } else {
      result.pending.assign(input.begin() + static_cast<std::ptrdiff_t>(sequence_start), input.end());
    }
  }
  if (final) {
    map_start = start_offset + static_cast<double>(input.size());
    if (!text_only) result.map.push_back(map_start);
  }
  result.map_start = map_start;
  return result;
}

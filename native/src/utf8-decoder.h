#pragma once
#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

struct Utf8DecodedBlock {
  std::u16string text;
  std::vector<double> map;
};

Utf8DecodedBlock DecodeUtf8Block(const std::vector<unsigned char>& bytes, double offset, bool text_only);

struct Utf8DecodedChunk {
  std::u16string text;
  std::vector<double> map;
  std::vector<unsigned char> pending;
  double map_start = 0;
  bool cancelled = false;
};

Utf8DecodedChunk DecodeUtf8Chunk(const std::vector<unsigned char>& bytes,
                                 const std::vector<unsigned char>& pending,
                                 double offset, double map_start, bool final,
                                 bool text_only, const std::atomic<bool>* cancelled);

// Match the path shortening and URL masking used for documents.
const START = String.raw`(?:file:(?:/{2,}[a-zA-Z]:[\\/]+|//[^/\s"'<>|]+/[^/\s"'<>|]+/?)|\\{2,}\?\\+(?:UNC\\+|[a-zA-Z]:\\+)|[a-zA-Z]:[\\/]+|(?<!:)[\\/]{2,}[^\\/\s"'<>|?*]+[\\/]+)`;
const PATH_REGEX = new RegExp(`"(?<quoted>${START}[^"\\r\\n]*)"|'(?<singleQuoted>${START}[^'\\r\\n]*)'|(?<![\\p{L}\\p{N}_/\\\\])(?<bare>${START}(?:(?![a-zA-Z]:[\\\\/]|\\s+[\\\\/]{2,})[^\\x00-\\x1f"'<>|?*,;])*)`, "giu");
function collectPaths(text) {
  PATH_REGEX.lastIndex = 0;
  const matches = [];
  let match;
  while ((match = PATH_REGEX.exec(text)) !== null) {
    const quoted = match.groups.quoted ?? match.groups.singleQuoted;
    let value = quoted ?? match.groups.bare.trimEnd();
    if (match.groups.bare !== undefined) {
      value = trimBarePath(value);
      const hasFileExtension = /(?:^|[\\/])[^\\/\s]+\.[a-zA-Z0-9]{1,10}$/.test(value);
      if (/\s/.test(value) && !hasFileExtension && !/[\\/]$/.test(value))
        continue;
    }
    try {
      matches.push({ index: match.index + match[0].indexOf(quoted ?? match.groups.bare), value, names: normalizedPathNames(value) });
    }
    catch { /* Ignore malformed path candidates. */ }
  }
  return matches;
}
function trimBarePath(value) {
  const slash = Math.max(value.lastIndexOf("\\"), value.lastIndexOf("/")) + 1;
  const leaf = value.slice(slash);
  const endings = [...leaf.matchAll(/\.[^\s\\/:.!]+(?=\s|[!:]|\.(?:\s|$)|$)/g)];
  const ending = endings[0];
  if (ending) {
    const end = slash + ending.index + ending[0].length;
    const tail = value.slice(end);
    if (!/[\\/]/.test(tail)) {
      if (tail.startsWith(":") && !/^:\d+(?::|$)/.test(tail)) {
        const stream = /^:[^\s]+/.exec(tail);
        return value.slice(0, end + (stream?.[0].length ?? 0));
      }
      return value.slice(0, end);
    }
  }
  return value.replace(/[.!]+$/, "");
}
function normalizedPathNames(value) {
  let normalized = value;
  if (/^file:/i.test(normalized)) {
    normalized = decodeURIComponent(normalized.slice(5)).replaceAll("/", "\\");
    if (/^\\+[a-zA-Z]:\\/.test(normalized))
      normalized = normalized.replace(/^\\+/, "");
  }
  normalized = normalized.replaceAll("/", "\\");
  const isUnc = normalized.startsWith("\\\\");
  normalized = normalized.replace(/\\+/g, "\\");
  if (isUnc)
    normalized = "\\" + normalized;
  if (/^\\\\\?\\/i.test(normalized)) {
    normalized = normalized.slice(4);
    if (/^UNC\\/i.test(normalized))
      normalized = "\\\\" + normalized.slice(4);
  }
  let remainder;
  const drive = /^([a-zA-Z]:)\\/.exec(normalized);
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/.exec(normalized);
  if (drive) {
    remainder = normalized.slice(3);
  }
  else if (unc) {
    remainder = normalized.slice(unc[0].length);
  }
  else
    throw new Error("Unsupported path.");
  const names = [];
  for (const segment of remainder.split("\\")) {
    if (!segment || segment === ".")
      continue;
    if (segment === "..") {
      names.pop();
      continue;
    }
    const name = segment.split(":", 1)[0];
    if (name)
      names.push(name);
  }
  return names;
}
function shortenPaths(occurrences) {
  return occurrences.map((item) => {
    const value = item.value;
    let end = value.length;
    while (end > 0 && /[\\/]/.test(value[end - 1]))
      end--;
    let suffixStart = end;
    let searchFrom = end;
    for (let part = 0; part < Math.min(3, item.names.length); part++) {
      let index = searchFrom - 1;
      while (index >= 0 && !/[\\/]/.test(value[index]))
        index--;
      if (index < 0)
        break;
      suffixStart = index + 1;
      while (index >= 0 && /[\\/]/.test(value[index]))
        index--;
      searchFrom = index + 1;
    }
    let separatorStart = suffixStart;
    while (separatorStart > 0 && /[\\/]/.test(value[separatorStart - 1]))
      separatorStart--;
    const marker = `...${value.slice(separatorStart, suffixStart)}`;
    return { index: item.index, value, replacement: marker + value.slice(suffixStart) };
  });
}
function replaceMatches(text, matches) {
  let output = "";
  let cursor = 0;
  for (const item of matches) {
    output += text.slice(cursor, item.index) + item.replacement;
    cursor = item.index + item.value.length;
  }
  return output + text.slice(cursor);
}

function maskToken(value) {
  const length = value.length <= 3 ? 4 : value.length <= 6 ? 6 : value.length <= 10 ? 8 : value.length <= 15 ? 10 : 12;
  return "*".repeat(length);
}
function getUrlMasks(text) {
  const pattern = /\b(?<scheme>https?:\/\/)(?<domain>(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}|(?:\d{1,3}\.){3}\d{1,3}))(?<rest>(?::\d+)?(?:\/[^\s]*)?)/gi;
  return [...text.matchAll(pattern)].map(match => {
    const { scheme, domain, rest } = match.groups;
    const host = domain === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(domain)
      ? maskToken(domain) : domain.split(".").map(maskToken).join(".");
    return { index: match.index, value: match[0], replacement: scheme + host + (rest || "").replace(/[A-Za-z0-9_-]+/g, maskToken) };
  });
}

const urlCandidate = /\b(?:[a-z][a-z\d+.-]*:\/{2,}|www\.)[^\s<>]+/gi;
const unmaskedPath = /(?<![\p{L}\p{N}_.:/\\])(?:file:\/|[a-z]:[\\/]|[\\/]{2,}|\/(?=[^\s/]))/iu;

function maskIssueMessage(text) {
  const lines = [];
  for (const line of text.split(/\r\n?|\n/)) {
    const urls = getUrlMasks(line);
    const unsupportedUrl = [...line.matchAll(urlCandidate)].some(candidate => {
      if (/^file:/i.test(candidate[0])) return false;
      const url = urls.find(item => item.index === candidate.index);
      if (!url) return true;
      const tail = candidate[0].slice(url.value.length);
      return !/^[.,;!?)"'\]]*$/.test(tail) || /[\p{L}\p{N}]/u.test(url.replacement.slice(url.replacement.indexOf('://') + 3));
    });
    if (unsupportedUrl) continue;
    const maskedUrls = replaceMatches(line, urls);
    const masked = replaceMatches(maskedUrls, shortenPaths(collectPaths(maskedUrls)));
    if (unmaskedPath.test(masked.replace(/\bhttps?:\/\/\*\S*/gi, ''))) continue;
    lines.push(masked);
  }
  return lines.join('\n');
}

module.exports = { maskIssueMessage };

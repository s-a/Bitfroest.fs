$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ListerCodepages {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Info {
        public uint MaxCharSize;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 2)] public byte[] DefaultChar;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 12)] public byte[] LeadByte;
        public char UnicodeDefaultChar;
        public uint CodePage;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetCPInfoExW(uint codepage, uint flags, out Info info);
    public static object Decode(string encoded, uint codepage, bool textOnly) {
        Info info;
        if (!GetCPInfoExW(codepage, 0, out info)) throw new ArgumentException("Die Codeseite ist auf diesem System nicht verfügbar.");
        byte[] bytes = Convert.FromBase64String(encoded);
        if (textOnly) return new { text = Encoding.GetEncoding((int)info.CodePage).GetString(bytes), encoding = info.CodePage.ToString() };
        Decoder decoder = Encoding.GetEncoding((int)info.CodePage).GetDecoder();
        StringBuilder text = new StringBuilder();
        List<int> map = new List<int>();
        char[] chars = new char[8];
        int start = 0;
        for (int i = 0; i < bytes.Length; i++) {
            int count = decoder.GetChars(bytes, i, 1, chars, 0, false);
            if (count != 0) {
                text.Append(chars, 0, count);
                for (int j = 0; j < count; j++) map.Add(start);
                start = i + 1;
            }
        }
        int tail = decoder.GetChars(bytes, bytes.Length, 0, chars, 0, true);
        text.Append(chars, 0, tail);
        for (int j = 0; j < tail; j++) map.Add(start);
        map.Add(bytes.Length);
        return new { text = text.ToString(), map = map.ToArray(), encoding = info.CodePage.ToString() };
    }
}
'@
while ($null -ne ($line = [Console]::ReadLine())) {
    try {
        $request = $line | ConvertFrom-Json
        $result = [ListerCodepages]::Decode($request.bytes, [uint32]$request.codepage, [bool]$request.textOnly)
        [Console]::WriteLine(($result | ConvertTo-Json -Depth 4 -Compress))
    } catch {
        [Console]::WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
    }
}

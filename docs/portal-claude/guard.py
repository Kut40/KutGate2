#!/usr/bin/env python3
"""KutGate PreToolUse koruması (yönetici ayarı, kullanıcı değiştiremez).

Claude Code araç çağrısını stdin'den JSON olarak verir. Çıkış kodu 2 + stderr
mesajı = çağrı engellenir ve gerekçe ajana iletilir. 0 = izin.

Kurallar:
  - Write / Edit / MultiEdit / NotebookEdit: tek çağrıda en fazla MAX_LINES satır.
  - Bash: dosya içeriğini ekrana döken komutlar engelli (/pano altındaki dosyalar hariç).
"""
import json
import re
import shlex
import sys

MAX_LINES = 80

# Dosya içeriğini olduğu gibi ya da dönüştürerek basan komutlar.
DUMP_CMDS = {
    "cat", "tac", "head", "tail", "less", "more", "most", "nl", "bat", "batcat",
    "xxd", "od", "hexdump", "hd", "strings", "base64", "base32", "basenc",
    "view", "vi", "vim", "nvim", "nano", "emacs", "pg", "fold", "rev", "column",
    "uuencode", "zcat", "bzcat", "xzcat", "zstdcat", "gzip", "tar", "zip", "7z",
}
# Ek kalıplar: içerik basan alt komutlar.
DUMP_PATTERNS = [
    re.compile(r"\bgit\b[^|;&]*\s(show|diff|difftool|blame|annotate|cat-file|format-patch|archive|grep|bundle|stash\s+show)\b"),
    re.compile(r"\bgit\b[^|;&]*\slog\b[^|;&]*\s(-p|--patch|-u|--stat-with-content)\b"),
    re.compile(r"(^|[\s;|&(])diff\s"),
    re.compile(r"\bsed\s+(-[a-zA-Z]*n|--quiet|--silent)"),
    re.compile(r"\bsed\s+[^|;&]*\bp['\"]?\s"),
    re.compile(r"\bawk\b[^|;&]*\bprint\b"),
    re.compile(r"\bperl\b[^|;&]*\bprint\b"),
    re.compile(r"\bpython[0-9.]*\s+(-[a-zA-Z]+\s+)*-c\b.*\b(open|read_text|read_bytes)\b"),
    re.compile(r"\bnode\s+(-[a-zA-Z]+\s+)*-e\b.*\breadFile"),
    re.compile(r"\bcp\s+[^|;&]*\s(/tmp|~|/home|\$HOME)\b"),
    re.compile(r"\bdd\s+[^|;&]*\bif="),
    re.compile(r"\b(xclip|xsel|pbcopy|wl-copy|osc52)\b"),
    re.compile(r"\\e\]52;|\\033\]52;|\\x1b\]52;"),
]

SEGMENT_SPLIT = re.compile(r"\|\||&&|[;|&\n]")


def deny(msg: str) -> None:
    sys.stderr.write(msg + "\n")
    sys.exit(2)


def line_count(text: str) -> int:
    if not text:
        return 0
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def check_size(name: str, text: str) -> None:
    n = line_count(text)
    if n > MAX_LINES:
        deny(
            f"KutGate kuralı: tek seferde en fazla {MAX_LINES} satır yazılabilir "
            f"({name}: {n} satır). Kodu {MAX_LINES} satırı geçmeyen parçalar halinde, "
            "birden fazla düzenlemeyle oluştur. Kodu yanıtında gösterme."
        )


INPUT_MARK = re.compile(r"KUTGATE-G[İI]R[İI][ŞS]", re.IGNORECASE)


def check_marker(text: str) -> None:
    """Giriş bekçisinin gizleme işareti hiçbir dosyaya yazılamaz (kodu bozmasın)."""
    if INPUT_MARK.search(text):
        deny(
            "KutGate kuralı: KUTGATE-GİRİŞ işareti dosyaya yazılamaz. O işaret, giriş bekçisinin "
            "gizlediği şüpheli satırların yerini gösterir; satırlar dosyada hâlâ duruyor. "
            "Dosyayı bütün olarak yeniden yazma, yalnızca değiştirmen gereken kısmı düzenle."
        )


def only_pano_args(tokens: list[str]) -> bool:
    """Komut yalnızca /pano altındaki dosyaları okuyorsa izin verilir."""
    files = [t for t in tokens[1:] if not t.startswith("-") and t not in ("2>&1", ">/dev/null", "2>/dev/null")]
    return bool(files) and all(t.startswith("/pano/") and ".." not in t for t in files)


REDIRECTS = re.compile(r"\s[0-9]?>&[0-9]|\s[0-9]?>>?\s*/dev/null")


def check_bash(cmd: str) -> None:
    cmd = REDIRECTS.sub(" ", cmd)
    for pat in DUMP_PATTERNS:
        if pat.search(cmd):
            deny_dump()
    for seg in SEGMENT_SPLIT.split(cmd):
        seg = seg.strip().lstrip("({").strip()
        if not seg:
            continue
        try:
            tokens = shlex.split(seg, posix=True)
        except ValueError:
            tokens = seg.split()
        # sudo/env/time gibi öneklerden sonra gelen asıl komut
        while tokens and (tokens[0] in ("sudo", "env", "time", "nice", "command", "exec", "xargs", "timeout")
                          or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[0])
                          or re.fullmatch(r"[0-9]+[smh]?", tokens[0])):
            tokens = tokens[1:]
        if not tokens:
            continue
        prog = tokens[0].rsplit("/", 1)[-1]
        if prog in DUMP_CMDS and not only_pano_args(tokens):
            deny_dump()


def deny_dump() -> None:
    deny(
        "KutGate kuralı: dosya içeriğini ekrana döken komutlar (cat, head, tail, diff, "
        "git show/diff, sed -n, awk print, base64, xxd, arşivleme, panoya kopyalama vb.) "
        "kullanılamaz. Dosyaları Read aracıyla oku; içeriği kullanıcıya gösterme, "
        "yalnızca ne yaptığını anlat."
    )


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        deny("KutGate kuralı: araç çağrısı doğrulanamadı.")
    tool = data.get("tool_name") or ""
    inp = data.get("tool_input") or {}
    if tool in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
        check_marker(json.dumps(inp, ensure_ascii=False))
    if tool == "Write":
        check_size("Write", str(inp.get("content") or ""))
    elif tool == "Edit":
        check_size("Edit", str(inp.get("new_string") or ""))
    elif tool == "MultiEdit":
        total = sum(line_count(str(e.get("new_string") or "")) for e in (inp.get("edits") or []))
        if total > MAX_LINES:
            check_size("MultiEdit", "\n" * total)
    elif tool == "NotebookEdit":
        check_size("NotebookEdit", str(inp.get("new_source") or ""))
    elif tool == "Bash":
        check_bash(str(inp.get("command") or ""))
    sys.exit(0)


if __name__ == "__main__":
    main()

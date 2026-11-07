"""autovol.py - makes volatile (in a COPY of the project) every local/parameter that SDCC keeps in a
register or optimises away, so that a debugger can always read it from the stack.
usage: autovol.py <project_copy_dir> <main_module> --iterate N [--engine-build path/to/build.js]
Every <module>.c of the project (banked builds have <main>_sN_bM.c too) is processed.
master source: <module>.c.orig ; state: autovol_state_<module>.json / autovol_params_<module>.json
"""
import re, sys, json, os, subprocess, collections

proj, name = sys.argv[1], sys.argv[2]
do_build = True
SRC = ORIG = ADB = STATE = PSTATE = ""

def use(mod):
    """select the module the helper functions below work on"""
    global name, SRC, ORIG, ADB, STATE, PSTATE
    name = mod
    SRC = os.path.join(proj, mod + ".c")
    ORIG = SRC + ".orig"
    ADB = os.path.join(proj, "out", mod + ".adb")
    STATE = os.path.join(proj, "autovol_state_%s.json" % mod)
    PSTATE = os.path.join(proj, "autovol_params_%s.json" % mod)

use(name)

TYPES = r"(?:const\s+)?(?:unsigned\s+|signed\s+)?(?:u8|u16|u32|i8|i16|i32|bool|char|int|short|long|c8|f32)\b"

def load_state():
    if os.path.exists(STATE):
        return {tuple(x) for x in json.load(open(STATE))}
    return set()

def save_state(s):
    json.dump(sorted(s), open(STATE, "w"))

def classify():
    """-> dict (func,var,id) -> ('stack'|'reg'|'nopos', size, isparam)"""
    out = {}
    for ln in open(ADB, encoding="latin-1"):
        m = re.match(r"S:L%s\.(\w+)\$(\w+)\$(\d+)_(\d+)\$(\d+)\(\{(\d+)\}.*?\),([BR]),(\d+),(-?\d+)(?:,\[(.*)\])?" % name, ln)
        if not m: continue
        f, v, lvl, blk, vid, size, cls, _, off, regs = m.groups()
        if v.startswith("__"): continue
        if cls == "B": k = "stack"
        elif regs: k = "reg"
        else: k = "nopos"
        out[(f, v, vid)] = (k, int(size), vid == "0")
    return out

# qualifiers allowed between the parameter list and the body: __banked, __naked, __critical, __interrupt(n)...
QUAL = re.compile(r"\s*(?:__\w+(?:\([^)]*\))?\s*)*")

def mask(t):
    """sostituisce commenti e stringhe con spazi (stessa lunghezza)"""
    def blank(m): return re.sub(r"[^\n]", " ", m.group(0))
    t = re.sub(r"/\*.*?\*/", blank, t, flags=re.S)
    t = re.sub(r"//[^\n]*", blank, t)
    t = re.sub(r'"(?:\\.|[^"\\\n])*"', blank, t)
    t = re.sub(r"'(?:\\.|[^'\\\n])*'", blank, t)
    return t

def func_body(mt, func):
    for m in re.finditer(r"(?m)^[A-Za-z_][\w \t\*]*?\b%s\s*\(" % re.escape(func), mt):
        i = m.end(); d = 1
        while i < len(mt) and d:
            d += (mt[i] == "(") - (mt[i] == ")"); i += 1
        j = QUAL.match(mt, i).end()
        if j < len(mt) and mt[j] == "{":
            k = j; d = 0
            while k < len(mt):
                d += (mt[k] == "{") - (mt[k] == "}")
                k += 1
                if d == 0: break
            return j, k
    return None

def split_top(s):
    parts, d, cur = [], 0, ""
    for ch in s:
        if ch in "([{": d += 1
        elif ch in ")]}": d -= 1
        if ch == "," and d == 0: parts.append(cur); cur = ""
        else: cur += ch
    parts.append(cur)
    return parts

def apply(targets):
    """targets: set (func,var). Ritorna (testo, decl_fatte, non_trovate)"""
    text = open(ORIG, encoding="latin-1").read()
    mt = mask(text)
    edits = []          # (pos, stringa)
    done, missing = set(), set()
    byf = collections.defaultdict(set)
    for f, v in targets: byf[f].add(v)
    for f, vs in byf.items():
        fb = func_body(mt, f)
        if not fb:
            missing |= {(f, v) for v in vs}; continue
        a, b = fb
        body = mt[a:b]
        for m in re.finditer(r"(?<=[{;(])\s*(?P<ty>%s)\s+(?P<decl>[^;{}()]*(?:\([^;{}]*\)[^;{}()]*)*?)\s*(?=;)" % TYPES, body):
            decl = m.group("decl")
            names = []
            for p in split_top(decl):
                pm = re.match(r"\s*(\**)\s*(\w+)\s*(?:\[[^\]]*\])?\s*(?:=|$)", p)
                names.append((pm.group(1), pm.group(2), p) if pm else None)
            if any(n is None for n in names): continue
            hit = [n for n in names if n[1] in vs]
            if not hit: continue
            if any("[" in n[2].split("=")[0] for n in hit):   # array: non toccare
                continue
            base = a + m.start("ty")
            # puntatori: volatile prima del nome; scalari: volatile prima del tipo
            scal = [n for n in hit if not n[0]]
            if scal and "volatile" not in text[base - 9:base]:
                edits.append((base, "volatile "))
            # posizione dei nomi puntatore
            off = a + m.start("decl")
            for p in split_top(decl):
                pm = re.match(r"(\s*\**\s*)(\w+)", p)
                if pm and pm.group(1).strip() and pm.group(2) in vs:
                    edits.append((off + len(pm.group(1)), "volatile "))
                off += len(p) + 1
            done |= {(f, n[1]) for n in hit}
        missing |= {(f, v) for v in vs if (f, v) not in done}
    for pos, s in sorted(edits, reverse=True):
        text = text[:pos] + s + text[pos:]
    return text, done, missing

def build():
    bjs = sys.argv[sys.argv.index("--engine-build") + 1] if "--engine-build" in sys.argv else os.path.join(proj, "..", "..", "engine", "script", "js", "build.js")
    r = subprocess.run(["node", os.path.abspath(bjs)],
                       cwd=proj, capture_output=True, text=True, errors="replace", timeout=550)
    return r.stdout + r.stderr

def load_pstate():
    return {tuple(x) for x in json.load(open(PSTATE))} if os.path.exists(PSTATE) else set()

def shadow_params(text, pset):
    """rinomina il parametro p -> p_ e aggiunge 'volatile T p = p_;' dopo la { (stessa riga)"""
    edits = []; done = set()
    mt = mask(text)
    byf = collections.defaultdict(set)
    for f, v in pset: byf[f].add(v)
    for f, vs in byf.items():
        for m in re.finditer(r"(?m)^[A-Za-z_][\w \t\*]*?\b%s\s*\(" % re.escape(f), mt):
            i = m.end(); d = 1
            while i < len(mt) and d:
                d += (mt[i] == "(") - (mt[i] == ")"); i += 1
            plist_a, plist_b = m.end(), i - 1
            j = QUAL.match(mt, i).end()
            if j >= len(mt) or mt[j] != "{": continue
            decls = []
            off = plist_a
            for p in split_top(mt[plist_a:plist_b]):
                pm = re.match(r"(.*?)(\w+)(\s*)$", p, re.S)
                if pm and pm.group(2) in vs and "[" not in p:
                    base = pm.group(1); name = pm.group(2)
                    edits.append((off + pm.end(2), "_"))
                    if "*" in base: decls.append("%s volatile %s = %s_;" % (base.rstrip(), name, name))
                    else: decls.append("volatile %s %s = %s_;" % (base.strip(), name, name))
                    done.add((f, name))
                off += len(p) + 1
            if decls: edits.append((j + 1, " " + " ".join(decls)))
            break
    for pos, s in sorted(edits, key=lambda e: -e[0]):
        text = text[:pos] + s + text[pos:]
    return text, done

def origin(f, v):
    """'param' | 'local' | 'foreign' secondo il sorgente utente"""
    mt = mask(open(ORIG, encoding="latin-1").read())
    for m in re.finditer(r"(?m)^[A-Za-z_][\w \t\*]*?\b%s\s*\(" % re.escape(f), mt):
        i = m.end(); d = 1
        while i < len(mt) and d:
            d += (mt[i] == "(") - (mt[i] == ")"); i += 1
        if re.search(r"\b%s\b" % re.escape(v), mt[m.end():i]): return "param"
        fb = func_body(mt, f)
        if fb and re.search(r"[\w\*]\s+\**\s*\b%s\b\s*(?:=|;|,|\[)" % re.escape(v), mt[fb[0]:fb[1]]): return "local"
        return "foreign"
    return "foreign"



import shutil
mods = [os.path.splitext(f)[0] for f in sorted(os.listdir(proj)) if f.endswith(".c")]
maxit = int(sys.argv[sys.argv.index("--iterate") + 1]) if "--iterate" in sys.argv else 6
S = {}
for m in mods:
    use(m)
    if not os.path.exists(ORIG):
        shutil.copyfile(SRC, ORIG)
    S[m] = (load_state(), load_pstate())

def build_all():
    for m in mods:
        use(m)
        st, ps = S[m]
        text, done, missing = apply(st)
        text, pdone = shadow_params(text, ps)
        open(SRC, "w", encoding="latin-1", newline="").write(text)
    log = build()
    open(os.path.join(proj, "autovol_build.log"), "w", encoding="utf-8").write(log)
    errs = [l for l in log.split(chr(10)) if re.search(r"error|Error", l) and "previous definition" not in l and "redefined" not in l]
    use(mods[0])
    if errs or not os.path.exists(os.path.join(proj, "out", name + ".cdb")):
        print("BUILD-ERROR")
        for l in errs[:12]: print("  ", l.strip()[:200])
        sys.exit(2)

left = total = 0
for it in range(maxit + 1):
    print("iteration %d: build (%s volatile)..." % (it, ", ".join("%s:%d+%d" % (m, len(S[m][0]), len(S[m][1])) for m in mods)), flush=True)
    build_all()
    left = total = nnew = 0
    for m in mods:
        use(m)
        if not os.path.exists(ADB): continue
        state, pstate = S[m]
        cl = classify()
        shadowed = {(f, v + "_") for f, v in pstate}
        bad = {(f, v) for (f, v, vid), (k, sz, isp) in cl.items() if k in ("reg", "nopos") and not isp and (f, v) not in shadowed}
        pbad = {(f, v) for (f, v, vid), (k, sz, isp) in cl.items() if k in ("reg", "nopos") and isp and (f, v) not in shadowed}
        fixable = {x for x in bad if origin(*x) == "local"}
        pfixable = {x for x in pbad if origin(*x) == "param"}
        new, newp = fixable - state, pfixable - pstate
        left += sum(1 for (f, v, vid), (k, sz, isp) in cl.items() if k in ("reg", "nopos") and (f, v) not in shadowed)
        total += len(cl)
        nnew += len(new) + len(newp)
        state |= fixable; pstate |= pfixable
        save_state(state); json.dump(sorted(pstate), open(PSTATE, "w"))
    print("  variables: %d, unreliable: %d, new volatile candidates: %d" % (total, left, nnew), flush=True)
    if not nnew: break
print("DONE unreliable_left=%d total=%d" % (left, total))

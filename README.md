# MSX-SDCC-Debugger (VS Code ↔ openMSX)

Step-by-step debugging of MSXgl / SDCC C programs, running in a real openMSX window.

* breakpoints on C lines (with conditions such as `x > 3 && y == 13`)
* continue / pause / step over / step into / step out (line based)
* call stack (IX chain + stack scan), locals, parameters, globals, registers, structs, arrays, pointers
* watch / hover expressions: `g_Maze.grid[1][2]`, `g_SamSprite.location.x`, `*p`, `x + y*32`, `$HL` …
* debug console: `!<tcl>` runs a raw Tcl command inside openMSX (e.g. `!keymatrixdown 7 0x80`)

## Two modes (`debugMode` in launch.json)

| mode | what it does | variables |
|---|---|---|
| `normal` | uses your build as is (same code, same timing) | ~86 % of the locals are on the stack and shown. Variables SDCC keeps in a register show `<in register C: not reliable…>`, eliminated ones `<optimized out>` |
| `full` | builds a COPY (`<drive>:\msxdbg\<project>`) with automatic `volatile` on every local / parameter that would live in a register, then debugs that build | every variable you declared is readable (the remaining ones come from MSXgl `inline` header functions). Code is ~3 % bigger and a bit slower |

Your sources are never modified: `full` mode works on the copy; breakpoints and stepping use your original
files (line numbers are preserved).

## Requirements
* build with `Debug = true;` in `project_config.js` (produces `out/<name>.cdb`)
* openMSX installed (setting `msxglDebugger.openmsxPath`)
* Python 3 in PATH for `full` mode (setting `msxglDebugger.pythonPath`), Node.js for the MSXgl build
* flat ROMs (`ROM_16K/32K/48K/64K`) and MSXgl mapper ROMs (`ROM_ASCII8`, `ROM_ASCII16`, `ROM_KONAMI`, `ROM_KONAMI_SCC`, `ROM_NEO8/16`, `ROM_YAMANOOTO`, with `BankedCall = true`)

## Mapper (banked) ROMs
Addresses of banked segments in the `.cdb` are `segment<<16 | cpu address`. The debugger reads the segment that is
currently mapped from MSXgl's `_g_CurrentSegment` variable, so breakpoints in bank N only fire while bank N is mapped,
the call stack follows `__banked` calls through the `___sdcc_bcall_ehl` trampoline, and stepping works inside any bank.
The target is read from `project_config.js` and openMSX gets the matching `-romtype` (ASCII8, ASCII16, Konami,
KonamiSCC, NEO8, NEO16, Yamanooto); for custom mappers pass the cartridge arguments in `extraArgs`.
In `full` mode every `<module>.c` of the project is processed, including the `<name>_sN_bM.c` segment files.

## launch.json
```json
{
  "version": "0.2.0",
  "configurations": [
    { "type": "msxgl", "request": "launch", "name": "MSXgl: normal",
      "rom": "${workspaceFolder}/out/${workspaceFolderBasename}.rom", "debugMode": "normal" },
    { "type": "msxgl", "request": "launch", "name": "MSXgl: full (all locals)",
      "rom": "${workspaceFolder}/out/${workspaceFolderBasename}.rom", "debugMode": "full",
      "projectDir": "${workspaceFolder}" }
  ]
}
```
Optional: `machine` (default `Sony_HB-55P`), `extraArgs` (extra openMSX arguments, e.g. `["-ext","msxdos2"]`),
`module` (main C file name without `.c`, default = rom name), `sourceRoot`, `stopOnEntry`, `romType`, `target`,
`showRegisterValues` (normal mode: show register-held values anyway, they can be stale).

Build the project first (task / `build.bat`), then press F5. In `full` mode the first launch compiles
3-4 times (~1-2 min); later launches reuse the copy while the sources are unchanged.

## How it talks to openMSX
openMSX is started with a small Tcl script (`-script`) that polls a temporary folder for command files and writes
reply files. No network socket is opened. Stepping is done by single-stepping the Z80 inside openMSX; calls are
stepped over with a temporary breakpoint at the return address.

## Manual
See [MANUAL.md](MANUAL.md) for the full user manual.

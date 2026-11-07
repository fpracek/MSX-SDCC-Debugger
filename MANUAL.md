# MSX-SDCC-Debugger — User Manual

Version 0.2.0 · VS Code extension for debugging C programs built with **SDCC** (typically through **MSXgl**) while they run in **openMSX**.

## 1. What it is

You write MSX games in C, compile them with SDCC, and today you can only `printf` or debug in assembly.
MSX-SDCC-Debugger lets you debug in **C source**, inside VS Code:

* breakpoints on C lines (also conditional),
* continue / pause / step over / step into / step out,
* call stack, local variables, parameters, globals, registers, structs, arrays, pointers,
* watch and hover expressions,
* ROMs with **mappers** (ASCII8/16, Konami, NEO…) including `__banked` calls.

The game runs in a normal openMSX window: you play with the keyboard while VS Code controls the CPU.

## 2. Requirements

| Item | Notes |
|---|---|
| VS Code ≥ 1.80 | |
| openMSX ≥ 20 | tested with 21.0, Windows |
| SDCC debug info | build with `Debug = true;` in MSXgl's `project_config.js` → produces `out/<name>.cdb` and `.noi` |
| Node.js | already needed by the MSXgl build |
| Python 3 | only for *full* mode |
| Windows | the openMSX control layer was developed and tested on Windows |

## 3. Installation

* From the Marketplace: search **MSX-SDCC-Debugger**; or
* from a file: `code --install-extension msx-sdcc-debugger-0.2.0.vsix`.

Then set (Settings → *MSX-SDCC-Debugger*):

* `msxglDebugger.openmsxPath` – full path of `openmsx.exe` (default `openmsx.exe`, i.e. it must be in `PATH`);
* `msxglDebugger.pythonPath` – Python executable for full mode (default `python`).

## 4. Quick start

1. In `project_config.js` make sure `Debug = true;` is set and build the project (`build.bat` / your task).
2. Create `.vscode/launch.json` in the project folder:

```json
{
  "version": "0.2.0",
  "configurations": [
    { "type": "msxgl", "request": "launch", "name": "MSX: debug (normal)",
      "rom": "${workspaceFolder}/out/${workspaceFolderBasename}.rom", "debugMode": "normal" },
    { "type": "msxgl", "request": "launch", "name": "MSX: debug (full, all locals)",
      "rom": "${workspaceFolder}/out/${workspaceFolderBasename}.rom", "debugMode": "full",
      "projectDir": "${workspaceFolder}" }
  ]
}
```

3. Open a `.c` file, click in the gutter to set a breakpoint, press **F5**.
4. openMSX opens and starts the ROM. Use the game normally; when execution reaches the breakpoint the emulator pauses and VS Code shows the line, the call stack and the variables.

> The ROM name and the project folder name usually coincide; if not, write the real path in `rom`.

## 5. The two modes

### 5.1 `normal`
Uses **your build as it is** — same code, same timing. SDCC keeps many locals in CPU registers or removes them; a
debugger cannot read those reliably. In this mode:

* variables on the stack (about 86 % of the locals in the projects measured) are shown with their real value;
* a variable held in a register is shown as `<in register C: not reliable here - use full mode>`;
* a variable eliminated by the compiler is shown as `<optimized out>`.

Set `"showRegisterValues": true` to also see register-held values; they can be stale after a `call`.

### 5.2 `full`
Builds a **copy** of the project (`<drive>:\msxdbg\<project>`, on the same drive as the project) in which every local variable and
parameter that SDCC would keep in a register (or drop) is declared `volatile`. SDCC then allocates them on the stack and the
debugger can always read them. Your sources are **never modified**; breakpoints and stepping use your original files
(line numbers are preserved).

* the first launch compiles 3–5 times (about 1–2 minutes for a small project, **10–20 minutes for a large one with 60+ modules**, which is limited to 3 builds); later launches reuse the build until a source changes, and after an edit the learned list of variables is kept so only 1–2 builds are needed;
* the copy is built in `<drive>:\msxdbg\<project>`: it must be on the **same drive as MSXgl** (the MSXgl build moves files between the engine and the project) and its path must be **short** (SDCC's link command line is limited to 8191 characters on Windows). Set `workDir` to use another folder; keep it out of Dropbox/OneDrive (file-sync tools break the build);
* typical cost: code ≈ 3 % larger and a little slower — use `normal` when timing matters;
* in banked builds each segment has a fixed size (8 KB for Yamanooto/ASCII8/Konami, 16 KB for ASCII16/NEO16): `volatile` makes code bigger, so if a segment would overflow, the tool keeps `volatile` on only part of the variables of that module (a message tells which). Variables of that module may then show `<in register …>`;
* what remains unreadable are variables of MSXgl `inline` header functions (`min`, `max`, `flag`, …) that you did not write.

## 6. Using the debugger

### 6.1 Breakpoints
Click the gutter. Right-click → *Edit Breakpoint* → *Expression* to add a condition, e.g. `x > 3 && y == 13`.
A breakpoint on a line with no code moves to the next line that has code. In mapper ROMs a breakpoint in bank *N* fires only while bank *N* is mapped.

### 6.2 Execution
| Command | Effect |
|---|---|
| Continue (F5) | resumes the emulator |
| Pause | breaks wherever the CPU is (even in BIOS code) |
| Step Over (F10) | next C line; calls (also BIOS, interrupts) are executed in full |
| Step Into (F11) | enters user functions; library/BIOS code without debug info is stepped over |
| Step Out (Shift+F11) | runs until the current function returns |

### 6.3 Variables panel
* **Locals** – parameters first, then locals visible at the current line. If two variables share a name in nested blocks the innermost is shown.
* **Registers** – PC, SP, IX, IY, AF, BC, DE, HL.
* **Globals** – all global/static variables with debug info.
* Structs, arrays (up to 256 elements per expansion) and pointers (`*` child) are expandable.
* Integers are shown in decimal and hex, `char` also as a character, pointers in hex.

### 6.4 Call stack
Frames are rebuilt from SDCC's `IX` frame chain. Functions without a frame (no locals) are found by scanning the stack for return addresses.
Unwinding stops at `<startup>` (crt0) or at library code without debug info. A function called with a tail jump (`jp`) has no frame of its own.

### 6.5 Watch / hover / Debug Console expressions
Supported syntax: variable names (locals of the selected frame, then globals), `.field`, `->field`, `[index]`, `*p`, `&x`,
numbers (decimal / `0x`), operators `+ - * / % == != < > <= >= && || & | ! ~`, parentheses, and registers `$HL`, `$A`… (16-bit: `$PC $SP $IX $IY $AF $BC $DE $HL`).

Examples: `g_Maze.grid[1][2]`, `g_SamSprite.location.x`, `x + y*32`, `*ptr`, `$HL`.

Special: in the Debug Console, an expression starting with `!` is executed as a **Tcl command inside openMSX**, e.g.
`!keymatrixdown 7 0x80` (press Return), `!debug read_block memory 0xC000 16`. Handy for scripting input.

## 7. Mapper (banked) ROMs

Supported: `ROM_ASCII8`, `ROM_ASCII16`, `ROM_KONAMI`, `ROM_KONAMI_SCC`, `ROM_NEO8`, `ROM_NEO16` and, in principle, `ROM_YAMANOOTO` (MSXgl projects with `BankedCall = true`).

* The debug info stores banked addresses as `segment<<16 | cpu address`; the extension reads the mapped segment from MSXgl's `_g_CurrentSegment` RAM variable.
* The target is read from `project_config.js` and openMSX receives the matching `-romtype`. For any other cartridge type (Yamanooto, custom) pass the arguments in `extraArgs`, or set `romType`.
* Calls through `__banked` functions are followed through the SDCC trampoline `___sdcc_bcall_ehl`; the other trampoline variants (`___sdcc_bcall`, `___sdcc_bcall_abc`) are not handled.
* In `full` mode every `<module>.c` of the project is processed, including the `<name>_sN_bM.c` segment files.

## 8. launch.json reference

| Attribute | Default | Description |
|---|---|---|
| `rom` | — (required) | path of the built `.rom` |
| `cdb` | `<rom>.cdb` | debug info file |
| `debugMode` | `normal` | `normal` or `full` |
| `projectDir` | — | project folder; **required for `full`** |
| `workDir` | `<drive>:\msxdbg\<project>` | folder where `full` mode builds its copy (same drive as MSXgl, short path) |
| `module` | rom file name | main C module name without `.c` |
| `sourceRoot` | project folder | where the `.c/.h` sources are searched (depth ≤ 4) |
| `openmsx` | setting | path of `openmsx.exe` |
| `machine` | from `Machine` in project_config.js (1→Sony_HB-55P, 2→Philips_NMS_8250, 2+→Panasonic_FS-A1WSX, 3→Panasonic_FS-A1GT) | openMSX machine id |
| `extraArgs` | `[]` | extra openMSX arguments, e.g. `["-ext","msxdos2"]` |
| `romType` | auto | openMSX `-romtype` |
| `target` | auto | MSXgl Target (read from `project_config.js`) |
| `stopOnEntry` | `false` | stop before the first instruction |
| `showRegisterValues` | `false` | normal mode: show register-held values anyway |

Commands (Ctrl+Shift+P): *MSXgl: Debug C (normal)* and *MSXgl: Debug C (full, all locals)* start a session without a launch.json.

## 9. How it works (for the curious)

* **Debug info**: the SDCC `.cdb` gives function addresses, line→address tables, variable types and stack offsets; the `.noi` gives symbol names.
* **openMSX link**: openMSX is started with a small Tcl script (`-script`) that polls a temporary folder for command files and writes reply files. No network socket is opened.
* **Stepping**: the Tcl script single-steps the Z80 until the PC reaches the start of a different C line; `CALL`s and interrupts are stepped over with a temporary breakpoint at the return address.
* **Full mode**: `tools/autovol.py` rewrites a copy of the sources, rebuilds, reads which variables are still in registers, and repeats until stable.

## 10. Limitations

* line-level stepping only (no instruction stepping, no reverse debugging);
* variables cannot be modified from the panel;
* only the main project modules have debug info; MSXgl library functions show as `0xADDR` / symbol names;
* ROM code copied to RAM is not mapped;
* developed and tested on Windows with openMSX 21.0; Yamanooto/NEO mappers untested.

## 11. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `.cdb not found` | build with `Debug = true;`; check `rom` path |
| `openMSX did not become ready` | wrong `openmsxPath`, or openMSX failed to start (try the same arguments by hand) |
| breakpoint is grey / "no code at this line" | the line has no code, or the file is not part of the build; rebuild |
| breakpoint never hits | the code path is not executed; in mapper ROMs check the bank is the one that runs |
| `openMSX closed (code=…)` mid-session | the emulator was closed or killed by another tool |
| variables show `<in register …>` | normal mode: use `full` mode |
| full mode fails | read `<drive>:\msxdbg\<project>utovol_build.log`; the project must build with `Debug = true;`; check Python |
| full mode "BUILD-ERROR" | the copy does not compile — usually the same error the normal build shows |
| wrong line / values after rebuilding | rebuild first: the `.cdb` must match the ROM that is loaded |

Environment variable `MSXDBG_TRACE=1` prints the unwinder's frame analysis in the Debug Console.

## 12. Uninstall / cleanup

Uninstall from the Extensions view. You may delete the `<drive>:\msxdbg` folder created by full mode.

Source and issues: https://github.com/fpracek/MSX-SDCC-Debugger

## Note on machines
`Machine` in `project_config.js` selects the openMSX machine: `1` → `Sony_HB-55P` (MSX1), `2` → `Philips_NMS_8250` (MSX2), `2+` → `Panasonic_FS-A1WSX`, `3` → `Panasonic_FS-A1GT`. Note that Sony_HB-75P is an MSX1. Override with `machine` if you use another set of system ROMs.

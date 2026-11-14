# Debugging scripts

When a script goes wrong, the Console says which line, and the script editor marks it. In the desktop app
you can also stop a game at a line of your script, step through it, and look at its variables. The editor
stays live the whole time, because the game runs in a window and a process of its own.

## Script errors

A script error in the Console ends with a link such as **Hero.ts:42**. Click it to open the script at that
line. If you open scripts in VS Code (*Options ▸ Editor ▸ Scripts*), the link opens the file there, at the
line.

The script editor marks every line that failed in the last run with a red squiggle. Hover it to read the
error and how many times it happened. The marks clear when you next press Play.

Line numbers are your own. A script runs under its path, `cleo-script:///Player/Hero.ts`, and line 42 of
your file is line 42 at runtime. The browser's own developer tools (F12) use the same names, so in a
browser you can find your scripts there by name.

## The debugger

The debugger stops a game that plays **in a window** (*Play ▸ Play in window*). It needs the desktop app:
a web page cannot drive another page's debugger. In a browser, press F12 in the game window instead: your
scripts are listed there by name.

A game playing in the editor's viewport runs on the editor's own thread, so a breakpoint cannot stop it
without freezing the editor too. Breakpoints are kept, but they do nothing there. The Debugger panel and
the script's tab say so, with a **Play in window** button that switches the Play target.

### Breakpoints

Click in the margin left of a line number to set a breakpoint; click it again to remove it. Right-click
the margin for more:

- **Add conditional breakpoint…** — stops only when an expression is true, such as `hp <= 0`.
- **Add logpoint…** — logs a message and never stops. Put expressions in braces: `hit {other.name} for
  {damage}`. The line appears in the Console under *Logpoint*, with a link back to the line.
- **Disable** / **Enable**, **Edit condition…**, **Remove**.

| Mark | Means |
|---|---|
| Red dot | A breakpoint. A bar across it: it has a condition. |
| Yellow diamond | A logpoint. |
| Hollow | Disabled, breakpoints are off, or waiting for a Restart (see below). |
| Yellow arrow and line | Where the game is stopped. |

Breakpoints belong to the project and are kept on this computer only. They move with their line as you
edit, and follow a script you rename.

A function with a breakpoint in it runs several times slower while the game is being debugged, even when
the breakpoint is never reached (it no longer runs optimized). Remove the ones you are done with, or switch
breakpoints off. Debugging costs nothing measurable otherwise.

**Edits and the running game.** The game runs the scripts as they were saved when you pressed Play.
After you change a script, its tab says *Changed since the game started*. Its breakpoints stay where they
were in the running code, and new or moved ones wait until you save and press **Restart**.

### When the game stops

The game stops at a breakpoint, on **Pause**, or where a script throws (see **Stop on exceptions**). The
editor comes to the front and opens the script at the line, and the Debugger panel shows where it
stopped. The game window freezes on its last frame, mutes its sound, and says *Paused in the Cleo editor*.

**Play** in the top bar continues the game (it reads *Stopped · Hero.ts:42* while the game is stopped).
**Stop** closes the game window as usual, and **Restart** rebuilds and reloads it.

Hover a name in the stopped script to see its value. Only plain names and member chains are evaluated
(`this.target.position`), never calls, so hovering cannot change the game.

## The Debugger panel

The Debugger panel sits in the bottom strip beside Logger. It comes forward on its own when the game stops.

| Control | Key | Does |
|---|---|---|
| **Continue** | F8 | Run on from here. The game window comes forward again. |
| **Pause** | F8 | Stop at the next line of a script that runs. |
| **Step over** | F10 | Run this line, calls and all. |
| **Step into** | F11 | Go into the function this line calls, if it is one of your scripts. |
| **Step out** | Shift + F11 | Finish this function. |
| **Stop on exceptions** | | Stop where a script throws, instead of only logging the error. On by default. |
| **Breakpoints on** | | Off lets the game run past every breakpoint without removing them. |

The keys work while a game is being debugged. Stepping never enters engine code: past the end of a
handler, a step goes on to the next line of a script that runs.

**Stop on exceptions** also stops for an exception a script catches itself. An error in `onUpdate`
happens every frame: when stopped on one, **Don't stop here again** goes on and stops no more for that
line until the game ends.

**Call stack** — where the game is stopped, innermost first: the function, its script and line, and the
node the script runs on. Engine code between your frames folds into one row. Click a frame to see its
variables and its line.

**Variables** — the selected frame's local variables, the values its closures hold, and `this`, the
script's node. Expand an object to see its properties; your script's fields come first and the engine's
internal fields are folded. The **Evaluate** box below runs an expression in the selected frame.

**Breakpoints** — every breakpoint in the project: click one to open its line, tick it to switch it on or
off, or remove it. *not run yet* means the line has not run in this game; *after Restart*, that its
script changed since the game was built.

## See also

[Scripting workflow](scripting-workflow.md) · [The editor interface](interface.md#play-in-window) ·
[Scripting getting started](../scripting/getting-started.md)

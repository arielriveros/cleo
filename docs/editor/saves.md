# Saves

The Saves panel lists the saves a project's game wrote while it played in the editor, newest first.
It sits in the bottom strip beside Logger and Assets. Play in the editor and Play in window save to the
same place, the project's **Play saves**, and the list keeps up as the game saves.

How a game saves is in [Saving and loading](../scripting/save-game.md). Which nodes take part is set on
each node's Save card (see [Node inspector](node-inspector.md#common-sections)).

## The list

| Column | What it shows |
|---|---|
| **Slot** | The slot the game saved into (`SaveGame.save('auto')` saves into `auto`). |
| **Label** | The caption the game gave the save, or the scene's name. |
| **Scene** | The scene it was saved in, which is the one a load starts in. |
| **Saved** | When it was written. |
| **Play time** | The play time it carries, counting what the save it was loaded from had. |
| **Size** | How large the stored save is. |

Select a save to see its whole document beside the list: the globals, and the state of every node it
keeps, scene by scene.

## Actions

The strip above the list, from the left:

- **Play from this save** — start the game from the selected save: its globals and scene memory, in
  the scene it was saved in. In the editor or in a window, as the Play button's target says. Double-click
  a save does the same. Not while a game is running.
- **Export this save as a .cleosave file** — download the selected save, to keep it, attach it to a bug
  report, or try it in another project.
- **Import a .cleosave file** — add a save file to this project's Play saves. A save of the same slot is
  never overwritten: the import takes the next free name (`auto-2`).
- **Delete this save** — remove the selected save.
- **Delete all Play saves** — remove every save in this project's Play saves.

> Play saves belong to the editor on this machine. A published game keeps its own saves (see
> [Publishing](publishing.md#saves)); nothing here touches them, and they do not show here.

## See also

[Saving and loading](../scripting/save-game.md) · [Publishing](publishing.md#saves) ·
[Interface](interface.md#every-panel)

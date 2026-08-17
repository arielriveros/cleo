import { useEffect } from "react";
import MenuBar from "./MenuBar";
import TabBar from "./TabBar";
import DockLayout from "./layout/DockLayout";
import ModelImportModal from "./models/ModelImportModal";
import ProgressWindow from "./progress/ProgressWindow";
import AnimationImportModal from "./animation/AnimationImportModal";
import UnsavedSceneModal from "./dialogs/UnsavedSceneModal";
import { StateMachineProvider } from "./animation/StateMachineContext";
import { AnimationFieldProvider } from "./animationField/AnimationFieldContext";
import { TilesetProvider } from "./tileset/TilesetContext";
import { HistoryProvider, useHistory } from "./HistoryContext";
import DimensionSwitchModal from "./dialogs/DimensionSwitchModal";
import { useDocument } from "./DocumentContext";

// Ctrl/Cmd+S saves the active tab, Ctrl/Cmd+Shift+S saves everything. Bound on the window (capture phase)
// so it fires wherever focus is — including inside the Monaco script editor, which handles Ctrl+S itself
// and would otherwise swallow it.
function useSaveShortcuts() {
  const { saveActiveTab, saveAll } = useDocument();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 's' || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) void saveAll();
      else void saveActiveTab();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [saveActiveTab, saveAll]);
}

/**
 * Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z (or Ctrl+Y) redoes.
 *
 * The exact INVERSE of useSaveShortcuts' binding: that one is capture-phase precisely to steal Ctrl+S from
 * Monaco, whereas undo must leave text fields and the code editor alone so typing keeps its own history.
 */
function useUndoShortcuts() {
  const { undo, redo } = useHistory();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable
        || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
        || target.closest('.monaco-editor'))) return;
      e.preventDefault();
      if (key === 'y' || e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);
}

/**
 * The shell's contents. Split out from `Editor` because it sits INSIDE HistoryProvider — the menu bar's
 * Undo/Redo buttons and the shortcuts below both read that session, and a component cannot consume a
 * context it provides itself.
 */
function Shell() {
  useSaveShortcuts();
  useUndoShortcuts();
  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <MenuBar />
      {/* Each authoring session wraps the whole dock so its panels keep the working copy wherever the
          user drags them. Only one is ever live at a time — each keys off the active tab. */}
      <StateMachineProvider>
        <AnimationFieldProvider>
          <TilesetProvider>
            <TabBar />
            <DockLayout />
          </TilesetProvider>
        </AnimationFieldProvider>
      </StateMachineProvider>
      {/* Global mesh-import review modal — overlays the whole editor while an import awaits the user. */}
      <ModelImportModal />
      {/* The editor's one progress surface — import, publish, export, save, thumbnail refresh all report
          here. A floating card stack, not a modal, so it can stay up underneath the review modal. */}
      <ProgressWindow />
      {/* Global animation-import review modal (compatibility vs the skeleton). */}
      <AnimationImportModal />
      {/* Save/Discard/Cancel prompt when unsaved edits would be lost (scene switch, or closing a tab). */}
      <UnsavedSceneModal />
      {/* Warns when switching a scene's dimension would strand the other dimension's authoring. */}
      <DimensionSwitchModal />
    </div>
  );
}

// Editor shell: a plain flex column of MenuBar (30px), the document TabBar (30px) and the Dockview
// workspace. All panel geometry — sidebars, bottom bar, floating groups, per-mode visibility and
// layout persistence — lives in DockLayout; the viewport and its overlays are dock panels there.
export default function Editor() {
  return (
    <HistoryProvider>
      <Shell />
    </HistoryProvider>
  );
}

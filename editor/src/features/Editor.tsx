import { useEffect } from "react";
import MenuBar from "./MenuBar";
import TabBar from "./TabBar";
import DockLayout from "./layout/DockLayout";
import ModelImportModal from "./models/ModelImportModal";
import ProgressWindow from "./progress/ProgressWindow";
import AnimationImportModal from "./animation/AnimationImportModal";
import UnsavedSceneModal from "./dialogs/UnsavedSceneModal";
import { StateMachineProvider } from "./animation/StateMachineContext";
import { useCleoEngine } from "./EngineContext";

// Ctrl/Cmd+S saves the active tab, Ctrl/Cmd+Shift+S saves everything. Bound on the window (capture phase)
// so it fires wherever focus is — including inside the Monaco script editor, which handles Ctrl+S itself
// and would otherwise swallow it.
function useSaveShortcuts() {
  const { saveActiveTab, saveAll } = useCleoEngine();
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

// Editor shell: a plain flex column of MenuBar (30px), the document TabBar (30px) and the Dockview
// workspace. All panel geometry — sidebars, bottom bar, floating groups, per-mode visibility and
// layout persistence — lives in DockLayout; the viewport and its overlays are dock panels there.
export default function Editor() {
  useSaveShortcuts();
  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <MenuBar />
      <StateMachineProvider>
        <TabBar />
        <DockLayout />
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
    </div>
  );
}

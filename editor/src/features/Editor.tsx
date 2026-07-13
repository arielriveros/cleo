import MenuBar from "./MenuBar";
import TabBar from "./TabBar";
import DockLayout from "./layout/DockLayout";
import MeshImportModal from "./meshes/MeshImportModal";
import AnimationImportModal from "./animation/AnimationImportModal";
import { StateMachineProvider } from "./animation/StateMachineContext";

// Editor shell: a plain flex column of MenuBar (30px), the document TabBar (30px) and the Dockview
// workspace. All panel geometry — sidebars, bottom bar, floating groups, per-mode visibility and
// layout persistence — lives in DockLayout; the viewport and its overlays are dock panels there.
export default function Editor() {
  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <MenuBar />
      <StateMachineProvider>
        <TabBar />
        <DockLayout />
      </StateMachineProvider>
      {/* Global mesh-import review modal — overlays the whole editor while an import awaits the user. */}
      <MeshImportModal />
      {/* Global animation-import review modal (compatibility vs the skeleton). */}
      <AnimationImportModal />
    </div>
  );
}

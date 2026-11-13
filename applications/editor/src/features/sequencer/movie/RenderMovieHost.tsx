import { DocScope } from '@cleo/app-kit/docs/DocScope'
import RenderMovieDialog from './RenderMovieDialog'
import { closeRenderMovie, useRenderMovieOpen } from './movieDialogStore'

/** The Render Movie dialog's one mount: above the panels, so it stays up while the render has the scene tab. */
export default function RenderMovieHost() {
  const open = useRenderMovieOpen()
  if (!open) return null
  return <DocScope page='editor/sequencer'><RenderMovieDialog onClose={closeRenderMovie} /></DocScope>
}

import { useEffect, useState } from 'react';
import { loadProjects } from '../../utils/projects';
import { activeProjectId } from '../../utils/projectScope';

/**
 * The open project's name ('' until it loads). Read from the projects store, and pushed by the
 * `cleo:project-renamed` event that Options ▸ Project dispatches on a rename. A rename elsewhere (the
 * Projects modal) is caught by changing `refreshKey`, which re-reads the store.
 */
export function useProjectName(refreshKey?: unknown): string {
  const [name, setName] = useState('');
  useEffect(() => {
    let live = true;
    void loadProjects().then(list => { if (live) setName(list.find(p => p.id === activeProjectId())?.name ?? ''); });
    return () => { live = false; };
  }, [refreshKey]);
  useEffect(() => {
    const onRename = (e: Event) => setName((e as CustomEvent<string>).detail);
    window.addEventListener('cleo:project-renamed', onRename);
    return () => window.removeEventListener('cleo:project-renamed', onRename);
  }, []);
  return name;
}

import { useEffect, useState } from 'react';
import { Loader2, Printer } from 'lucide-react';
import { cadApiUrl } from '@text-to-cad/core/client';
import { Button } from '@text-to-cad/ui/primitives/button';
import { TooltipHint } from '@text-to-cad/ui/primitives/tooltip';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@text-to-cad/ui/primitives/dropdown-menu';

// The open file's print projects, from the workspace's print command (`cadgen/viewer/print_hook.py`, env
// CADGEN_PRINT_COMMAND). No command, or no project for this file: no button. One project opens on a click; several
// open a menu, the one the command names first at the top.
type PrintProject = { file: string; title: string };

const JSON_POST = { 'content-type': 'application/json', 'x-cadgen-viewer': '1' };

export function PrintButton({ file, origin }: { file: string; origin: string }) {
  const [projects, setProjects] = useState<PrintProject[]>([]);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    let live = true;
    setProjects([]);
    fetch(cadApiUrl('/__cad/print', { origin, params: { path: file } }))
      .then(response => (response.ok ? response.json() : { projects: [] }))
      .then(answer => { if (live) setProjects(Array.isArray(answer?.projects) ? answer.projects : []); })
      .catch(() => { if (live) setProjects([]); });
    return () => { live = false; };
  }, [file, origin]);
  if (!projects.length) return null;

  const open = async (project: PrintProject) => {
    setBusy(project.file);
    try {
      const response = await fetch(cadApiUrl('/__cad/print', { origin }), {
        method: 'POST', headers: JSON_POST, body: JSON.stringify({ path: file, file: project.file }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        window.alert(`${project.title}: ${detail?.error || 'could not be built'}`);
      }
    } finally {
      setBusy('');
    }
  };

  const icon = busy ? <Loader2 className="size-3.5 animate-spin" /> : <Printer className="size-3.5" />;
  const label = busy ? 'Building the print project…' : 'Open in Bambu Studio';
  if (projects.length === 1) {
    return <TooltipHint content={label}>
      <Button variant="ghost" size="icon-xs" className="size-6 text-muted-foreground" aria-label={label}
        disabled={!!busy} onClick={() => open(projects[0])}>{icon}</Button>
    </TooltipHint>;
  }
  return <DropdownMenu>
    <TooltipHint content={label}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" className="size-6 text-muted-foreground" aria-label={label}
          disabled={!!busy}>{icon}</Button>
      </DropdownMenuTrigger>
    </TooltipHint>
    <DropdownMenuContent align="end">
      <DropdownMenuLabel className="" inset={false}>Open in Bambu Studio</DropdownMenuLabel>
      {projects.map(project => <DropdownMenuItem key={project.file} className="" inset={false} onSelect={() => open(project)}>
        {project.title}
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

import { useEffect, useRef } from 'react'
import { Button, DocScope, Modal, ModalFooter, ModalHeader, NumberInput, Select, TextInput, cn } from '@cleo/app-kit/ui'
import { multiplayerPlay, useMultiplayerPlay, type MultiplayerPlayer } from './multiplayerPlay'
import { desktopDevHost } from './desktopPlay'

// Play › Multiplayer (multiplayerPlay.ts): the players, their links and networks, Start / Stop, and while it runs
// the host's and each player's readings — the NetSync debugger. The explanations are in docs/editor/multiplayer.md.

const MAX_PLAYERS = 8

export default function MultiplayerModal(props: {
  onClose: () => void
  build: () => Promise<any>
  size: () => { width: number; height: number; title: string }
}) {
  const mp = useMultiplayerPlay()
  const c = multiplayerPlay()
  // On opening, the desktop editor starts the dev host if none answers; an address being typed is only asked.
  const opened = useRef(false)
  useEffect(() => { void c.probe(!opened.current); opened.current = true }, [mp.devHost])
  const running = mp.status === 'running' || mp.status === 'starting'
  const managed = !!desktopDevHost()
  const setPlayer = (i: number, patch: Partial<MultiplayerPlayer>) =>
    c.setPlayers(mp.players.map((p, j) => (j === i ? { ...p, ...patch } : p)))

  return (
    <Modal onClose={props.onClose} className='w-[760px]'>
      <DocScope page='editor/multiplayer'>
        <ModalHeader title='Play › Multiplayer' doc='editor/multiplayer' />
        <div className='px-4 py-3 text-ui flex flex-col gap-3 max-h-[70vh] overflow-y-auto'>
          <div className='flex items-center gap-2'>
            <span className='w-[110px] text-muted'>Dev host</span>
            <TextInput value={mp.devHost} onChange={v => c.setDevHost(v.trim())} disabled={running} />
            <span className={cn('inline-block h-2 w-2 rounded-full',
              mp.hostReachable ? 'bg-success' : mp.hostStarting ? 'bg-warning' : mp.hostReachable === false ? 'bg-danger' : 'bg-control')} />
            <Button size='sm' variant='ghost' disabled={mp.hostStarting} onClick={() => void c.probe(true)}>Check</Button>
          </div>
          {mp.hostStarting
            ? <p className='text-ui-sm text-muted'>Starting the dev host…</p>
            : mp.hostReachable === false && (mp.hostNote
              ? <p className='text-ui-sm text-warning whitespace-pre-wrap'>{mp.hostNote}</p>
              : managed
                ? <p className='text-ui-sm text-warning'>No dev host there. Check starts one when the address is this machine's.</p>
                : <p className='text-ui-sm text-warning'>
                    No dev host there. Start one in a terminal at the repository: <code>npm run host -- --dev</code>
                  </p>)}

          <table className='w-full text-ui-sm'>
            <thead className='text-dim'>
              <tr><th className='text-left font-normal'>Player</th><th className='text-left font-normal'>Link</th>
                <th className='text-left font-normal'>Lag ms</th><th className='text-left font-normal'>Jitter ms</th>
                <th className='text-left font-normal'>Loss %</th><th /></tr>
            </thead>
            <tbody>
              {mp.players.map((p, i) => (
                <tr key={i}>
                  <td className='pr-1'><TextInput value={p.name} maxLength={32} disabled={running} onChange={v => setPlayer(i, { name: v })} /></td>
                  <td className='pr-1'>
                    <Select value={p.transport} disabled={running} onChange={e => setPlayer(i, { transport: e.target.value === 'websocket' ? 'websocket' : 'auto' })}>
                      <option value='auto'>WebTransport</option>
                      <option value='websocket'>WebSocket (fallback)</option>
                    </Select>
                  </td>
                  <td className='pr-1'><NumberInput value={p.lag} min={0} max={1000} step={5} disabled={running} onChange={v => setPlayer(i, { lag: Math.max(0, Math.min(1000, v)) })} /></td>
                  <td className='pr-1'><NumberInput value={p.jitter} min={0} max={500} step={5} disabled={running} onChange={v => setPlayer(i, { jitter: Math.max(0, Math.min(500, v)) })} /></td>
                  <td className='pr-1'><NumberInput value={p.loss} min={0} max={50} step={0.5} disabled={running} onChange={v => setPlayer(i, { loss: Math.max(0, Math.min(50, v)) })} /></td>
                  <td>
                    <Button size='sm' variant='ghost' disabled={running || mp.players.length <= 1}
                      onClick={() => c.setPlayers(mp.players.filter((_, j) => j !== i))}>Remove</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div>
            <Button size='sm' variant='ghost' disabled={running || mp.players.length >= MAX_PLAYERS}
              onClick={() => c.setPlayers([...mp.players, { name: `Player ${mp.players.length + 1}`, transport: 'auto', lag: 0, jitter: 0, loss: 0 }])}>
              Add player
            </Button>
          </div>

          {mp.error && <p className='text-ui-sm text-danger-fg'>{mp.error}</p>}

          {running && <NetSyncReadings />}
        </div>
        <ModalFooter>
          <Button onClick={props.onClose}>Close</Button>
          {running
            ? <Button variant='primary' onClick={() => c.stop()}>Stop</Button>
            : <Button variant='primary' className='font-semibold' disabled={!mp.hostReachable}
                onClick={() => c.start(props.build, props.size())}>Start</Button>}
        </ModalFooter>
      </DocScope>
    </Modal>
  )
}

/** The NetSync debugger: the host's tick and traffic, and each player's link and prediction. */
function NetSyncReadings() {
  const mp = useMultiplayerPlay()
  const c = multiplayerPlay()
  const h = mp.host
  const blocked = mp.windows.some(w => w.missing === 'blocked')
  return (
    <div className='flex flex-col gap-2 border-t border-control pt-2'>
      <div className='text-ui-sm'>
        <span className='font-semibold text-fg'>Host</span>{' '}
        {h ? (
          <span className='text-muted'>
            {h.state} · {h.scene || '—'} · tick {h.tick?.meanMs ?? 0} ms mean, {h.tick?.p95Ms ?? 0} p95 (budget {h.tick?.rate ? Math.round(1000 / h.tick.rate) : '—'}),
            {' '}{h.tick?.skipped ?? 0} skipped · {h.synced ?? 0} synced nodes · {h.peers?.length ?? 0} players · peak {h.peakBytesPerTick ?? 0} B/tick
          </span>
        ) : <span className='text-muted'>{mp.status === 'starting' ? 'building and starting the game…' : '—'}</span>}
      </div>
      <table className='w-full text-ui-sm'>
        <thead className='text-dim'>
          <tr><th className='text-left font-normal'>Player</th><th className='text-left font-normal'>Peer</th>
            <th className='text-left font-normal'>Link</th><th className='text-left font-normal'>RTT</th>
            <th className='text-left font-normal'>Corrected</th><th className='text-left font-normal'>Largest error</th></tr>
        </thead>
        <tbody>
          {mp.windows.map(w => {
            const r = w.report
            return (
              <tr key={w.sessionId} className='text-muted'>
                <td className='text-fg'>{w.player.name}</td>
                {w.failed ? <td colSpan={5} className='text-danger-fg'>{w.failed}</td> : w.missing ? (
                  <td colSpan={5}>
                    <span className='text-warning'>
                      {w.missing === 'closed' ? 'Its window was closed.' : 'No window: the browser most likely blocked the pop-up.'}
                    </span>{' '}
                    <Button size='sm' variant='ghost' onClick={() => c.reopen(w.sessionId)}>Open</Button>
                  </td>
                ) : r ? <>
                  <td>{r.peerId}</td>
                  <td title={r.fallbackReason ?? undefined}>{r.link}{r.fallbackReason ? ' (fallback)' : ''}</td>
                  <td>{r.rttMs} ms</td>
                  <td>{r.corrections} of {r.checked}</td>
                  <td>{r.maxErrorCm} cm</td>
                </> : <td colSpan={5}>{w.open ? 'joining…' : 'opening…'}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
      {blocked &&
        <p className='text-ui-sm text-muted'>
          A browser lets one click open one pop-up, so Start opens the first player's window and the rest wait for
          their Open. To have Start open them all, allow pop-ups for this site: the blocked pop-up icon at the right
          of the address bar › Always allow.
        </p>}
    </div>
  )
}

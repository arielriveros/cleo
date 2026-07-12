import React, { useEffect, useState } from 'react';
import { useCleoEngine } from '../EngineContext';

export default function Logger() {
  const { eventEmitter: eventEmitter } = useCleoEngine();
  const [filter, setFilter] = useState({
    log: true,
    info: true,
    warning: true,
    error: true
  });

  // Use state to manage logs and trigger re-renders
  const [logs, setLogs] = useState<{type: 'log' | 'info' | 'warning' | 'error', scope: string, message: string, timeStamp: string}[]>([]);

  useEffect(() => {
    const handleLog = (log: {type: 'log' | 'info' | 'warning' | 'error', scope: string, message: string, timeStamp: string}) => {
      // Update logs using setLogs to trigger a re-render
      setLogs((prevLogs) => [log, ...prevLogs]);
    };

    eventEmitter.on('LOG', handleLog);

    return () => {
      eventEmitter.off('LOG', handleLog);
    };
  }, [eventEmitter]);

  const btn = 'text-white h-[25px] border border-muted bg-control text-center w-[98px] inline-block cursor-pointer my-[2px] mx-[5px] px-2 rounded disabled:bg-selected disabled:border-white disabled:cursor-default';

  return (
    <div className='flex flex-col w-full h-full text-white bg-surface-raised'>
      <div className='flex flex-row items-center border-b border-border p-1'>
        <button className={btn + (!filter.log ? ' opacity-50' : '')} onClick={() => setFilter({...filter, log: !filter.log})} >Log</button>
        <button className={btn + (!filter.info ? ' opacity-50' : '')} onClick={() => setFilter({...filter, info: !filter.info}) }>Info</button>
        <button className={btn + (!filter.warning ? ' opacity-50' : '')} onClick={() => setFilter({...filter, warning: !filter.warning})}>Warning</button>
        <button className={btn + (!filter.error ? ' opacity-50' : '')} onClick={() => setFilter({...filter, error: !filter.error})}>Error</button>
      </div>
      <div className='flex flex-col w-full h-full overflow-y-auto p-2 gap-1'>
        {logs.map((log, index) => {
          if (!filter[log.type]) return null as any;
          const color = log.type === 'error' ? 'text-red-400' : log.type === 'warning' ? 'text-yellow-300' : log.type === 'info' ? 'text-blue-300' : 'text-white';
          return (
            <span key={index} className={`text-sm ${color}`}>
              [{log.scope}] {log.timeStamp} {log.message}
            </span>
          );
        })}
      </div>
    </div>
  );
}

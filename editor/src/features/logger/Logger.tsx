import React, { useEffect, useState } from 'react';
import { useCleoEngine } from '../EngineContext';
import './Styles.css';

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

  return (
    <div className='logger'>
      <div className='filters'>
        <button className={`filter-button${ 
          !filter.log ? ' disabled' : ''}`} onClick={() => setFilter({...filter, log: !filter.log})} >Log</button>
        <button className={`filter-button${
          !filter.info ? ' disabled' : ''}`} onClick={() => setFilter({...filter, info: !filter.info}) }>Info</button>
        <button className={`filter-button${
          !filter.warning ? ' disabled' : ''}`} onClick={() => setFilter({...filter, warning: !filter.warning})}>Warning</button>
        <button className={`filter-button${
          !filter.error ? ' disabled' : ''}`} onClick={() => setFilter({...filter, error: !filter.error})}>Error</button>
      </div>
      <div className='logs-container'>
        {logs.map((log, index) => {
          if (!filter[log.type]) return null;
          return (
            <span key={index} className={`log log-${log.type}`}>
              [{log.scope}] {log.timeStamp} {log.message}
            </span>
          );
        })}
      </div>
    </div>
  );
}
